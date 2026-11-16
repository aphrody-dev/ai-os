//! `agent_core` Python module (feature `python`; pyo3, abi3): the Hermes side reads and writes the same Context store as the TS core.
use crate::{Entry, Select, Store, now_ms};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use std::sync::Mutex;

fn err(e: impl std::fmt::Display) -> PyErr {
    PyRuntimeError::new_err(e.to_string())
}

#[pyclass(name = "Context")]
struct PyContext {
    store: Mutex<Store>,
}

#[pymethods]
impl PyContext {
    #[new]
    fn new(path: &str) -> PyResult<Self> {
        Ok(Self { store: Mutex::new(Store::open(path).map_err(err)?) })
    }

    #[pyo3(signature = (id, text, source="memory", scope="user", title=None, at=None))]
    fn ingest(&self, id: &str, text: &str, source: &str, scope: &str, title: Option<String>, at: Option<i64>) -> PyResult<()> {
        let e = Entry { id: id.into(), source: source.into(), scope: scope.into(), title, text: text.into(), at: at.unwrap_or_else(now_ms) };
        self.store.lock().map_err(err)?.ingest(&e).map_err(err)
    }

    fn remove(&self, id: &str) -> PyResult<()> {
        self.store.lock().map_err(err)?.remove(id).map_err(err)
    }

    /// Returns a list of dicts: id, source, scope, title, text, at, score.
    #[pyo3(signature = (query, k=8, sources=None, scopes=None, lexical=0.8, recency=0.2))]
    fn select<'py>(
        &self,
        py: Python<'py>,
        query: &str,
        k: usize,
        sources: Option<Vec<String>>,
        scopes: Option<Vec<String>>,
        lexical: f64,
        recency: f64,
    ) -> PyResult<Vec<Bound<'py, pyo3::types::PyDict>>> {
        let o = Select { k, sources, scopes, lexical, recency, half_life_days: 14.0, now_ms: None };
        let rows = self.store.lock().map_err(err)?.select(query, &o).map_err(err)?;
        rows.into_iter()
            .map(|s| {
                let d = pyo3::types::PyDict::new(py);
                d.set_item("id", s.entry.id)?;
                d.set_item("source", s.entry.source)?;
                d.set_item("scope", s.entry.scope)?;
                d.set_item("title", s.entry.title)?;
                d.set_item("text", s.entry.text)?;
                d.set_item("at", s.entry.at)?;
                d.set_item("score", s.score)?;
                Ok(d)
            })
            .collect()
    }
}

#[pymodule]
fn agent_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyContext>()?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
