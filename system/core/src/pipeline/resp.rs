//! Minimal RESP2 client for Valkey/Redis: one TCP connection, pipelining, no async runtime and no
//! dependency. Only what the pipeline needs (GET/MGET/SET, streams, pub/sub, blobs).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Nil,
    Int(i64),
    Bytes(Vec<u8>),
    Err(String),
    Array(Vec<Value>),
}

impl Value {
    pub fn into_bytes(self) -> Option<Vec<u8>> {
        match self {
            Self::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Bytes(b) => std::str::from_utf8(b).ok(),
            _ => None,
        }
    }

    pub fn into_array(self) -> Vec<Value> {
        match self {
            Self::Array(a) => a,
            _ => Vec::new(),
        }
    }
}

/// `valkey://[:password@]host[:port]` (also `redis://`).
#[derive(Debug, Clone)]
pub struct Url {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
}

impl Url {
    pub fn parse(s: &str) -> Result<Self, String> {
        let rest = s
            .trim()
            .strip_prefix("valkey://")
            .or_else(|| s.trim().strip_prefix("redis://"))
            .ok_or("url must start with valkey:// or redis://")?;
        let rest = rest.split('/').next().unwrap_or(rest);
        let (auth, hostport) = match rest.rsplit_once('@') {
            Some((a, h)) => (Some(a), h),
            None => (None, rest),
        };
        let password = auth
            .map(|a| a.split_once(':').map_or(a, |(_, p)| p).to_string())
            .filter(|p| !p.is_empty());
        let (host, port) = match hostport.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse::<u16>().map_err(|e| format!("port: {e}"))?),
            None => (hostport.to_string(), 6379),
        };
        if host.is_empty() {
            return Err("empty host".into());
        }
        Ok(Self { host, port, password })
    }
}

pub struct Client {
    reader: BufReader<TcpStream>,
}

impl Client {
    /// Connect, set TCP_NODELAY, apply `timeout` to connect/read/write and AUTH when needed.
    pub fn connect(url: &Url, timeout: Duration) -> Result<Self, String> {
        let addr = (url.host.as_str(), url.port)
            .to_socket_addrs()
            .map_err(|e| format!("resolve {}: {e}", url.host))?
            .next()
            .ok_or("no address")?;
        let stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect {addr}: {e}"))?;
        stream.set_nodelay(true).ok();
        stream.set_read_timeout(Some(timeout)).ok();
        stream.set_write_timeout(Some(timeout)).ok();
        let mut c = Self { reader: BufReader::with_capacity(1 << 16, stream) };
        if let Some(pw) = &url.password {
            match c.cmd(&[b"AUTH", pw.as_bytes()])? {
                Value::Err(e) => return Err(format!("AUTH: {e}")),
                _ => {}
            }
        }
        Ok(c)
    }

    pub fn set_read_timeout(&mut self, t: Option<Duration>) {
        self.reader.get_ref().set_read_timeout(t).ok();
    }

    fn write_cmd(buf: &mut Vec<u8>, args: &[&[u8]]) {
        buf.extend_from_slice(format!("*{}\r\n", args.len()).as_bytes());
        for a in args {
            buf.extend_from_slice(format!("${}\r\n", a.len()).as_bytes());
            buf.extend_from_slice(a);
            buf.extend_from_slice(b"\r\n");
        }
    }

    /// One command, one reply.
    pub fn cmd(&mut self, args: &[&[u8]]) -> Result<Value, String> {
        let mut buf = Vec::with_capacity(64);
        Self::write_cmd(&mut buf, args);
        self.reader.get_mut().write_all(&buf).map_err(|e| format!("write: {e}"))?;
        self.read_value()
    }

    /// Send every command in one write, then read one reply each (a single round trip).
    pub fn pipeline(&mut self, cmds: &[Vec<Vec<u8>>]) -> Result<Vec<Value>, String> {
        let mut buf = Vec::with_capacity(cmds.len() * 64);
        for c in cmds {
            let refs: Vec<&[u8]> = c.iter().map(Vec::as_slice).collect();
            Self::write_cmd(&mut buf, &refs);
        }
        self.reader.get_mut().write_all(&buf).map_err(|e| format!("write: {e}"))?;
        (0..cmds.len()).map(|_| self.read_value()).collect()
    }

    /// Read one reply (also used for pub/sub push messages after SUBSCRIBE).
    pub fn read_value(&mut self) -> Result<Value, String> {
        let mut line = Vec::with_capacity(64);
        let n = self.reader.read_until(b'\n', &mut line).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("connection closed".into());
        }
        if line.len() < 3 {
            return Err("short reply".into());
        }
        let body = &line[1..line.len() - 2];
        let text = || std::str::from_utf8(body).map_err(|e| e.to_string());
        match line[0] {
            b'+' => Ok(Value::Bytes(body.to_vec())),
            b'-' => Ok(Value::Err(text()?.to_string())),
            b':' => Ok(Value::Int(text()?.parse::<i64>().map_err(|e| e.to_string())?)),
            b'$' => {
                let len: i64 = text()?.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
                if len < 0 {
                    return Ok(Value::Nil);
                }
                let mut data = vec![0u8; len as usize + 2];
                std::io::Read::read_exact(&mut self.reader, &mut data).map_err(|e| format!("read: {e}"))?;
                data.truncate(len as usize);
                Ok(Value::Bytes(data))
            }
            b'*' => {
                let len: i64 = text()?.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
                if len < 0 {
                    return Ok(Value::Nil);
                }
                (0..len).map(|_| self.read_value()).collect::<Result<Vec<_>, _>>().map(Value::Array)
            }
            other => Err(format!("unexpected reply type {:?}", other as char)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn url_forms() {
        let u = Url::parse("valkey://:s3cret@192.0.2.3:6380").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.password.as_deref()), ("192.0.2.3", 6380, Some("s3cret")));
        let u = Url::parse("redis://localhost").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.password), ("localhost", 6379, None));
        assert!(Url::parse("http://x").is_err());
    }

    /// A scripted peer: reads one pipelined write, answers with every RESP type.
    #[test]
    fn parses_every_reply_type_over_a_pipeline() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf).unwrap();
            s.write_all(b"+OK\r\n:42\r\n$3\r\nabc\r\n$-1\r\n*2\r\n$1\r\nx\r\n*1\r\n:7\r\n-ERR boom\r\n").unwrap();
        });
        let url = Url { host: "127.0.0.1".into(), port, password: None };
        let mut c = Client::connect(&url, Duration::from_secs(2)).unwrap();
        let cmds: Vec<Vec<Vec<u8>>> = (0..6).map(|_| vec![b"PING".to_vec()]).collect();
        let r = c.pipeline(&cmds).unwrap();
        assert_eq!(r[0], Value::Bytes(b"OK".to_vec()));
        assert_eq!(r[1], Value::Int(42));
        assert_eq!(r[2], Value::Bytes(b"abc".to_vec()));
        assert_eq!(r[3], Value::Nil);
        assert_eq!(r[4], Value::Array(vec![Value::Bytes(b"x".to_vec()), Value::Array(vec![Value::Int(7)])]));
        assert_eq!(r[5], Value::Err("ERR boom".into()));
        h.join().unwrap();
    }
}
