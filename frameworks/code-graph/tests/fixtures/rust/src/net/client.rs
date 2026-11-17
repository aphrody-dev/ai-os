use crate::store::{Backend, Store, count};

pub struct Client {
    base: String,
}

impl Client {
    pub fn new(base: &str) -> Self {
        Client {
            base: base.to_owned(),
        }
    }

    pub fn url(&self, key: &str) -> String {
        format!("{}/{}", self.base, key)
    }
}

pub fn fetch_into(store: &mut Store, base: &str, key: &str) -> usize {
    let client = Client::new(base);
    let url = client.url(key);
    store.put(key, url);
    count(store)
}
