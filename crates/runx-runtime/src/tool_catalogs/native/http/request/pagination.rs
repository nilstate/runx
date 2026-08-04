use runx_contracts::{JsonNumber, JsonObject, JsonValue};

use super::super::resolution::{Pagination, estimated_size, json_u64, value_at_path};
use super::super::{MAX_HTTP_OUTPUT_BYTES, invalid};
use super::{PreparedRequest, RequestRuntime};
use crate::RuntimeError;
use crate::http::{HttpMethod, RuntimeHttpTransport};

struct PaginationRun {
    query: JsonObject,
    pages: Vec<JsonValue>,
    output_bytes: usize,
    item_count: usize,
    next_cursor: Option<String>,
    last: Option<JsonObject>,
}

impl PaginationRun {
    fn new(request: &PreparedRequest, pagination: &Pagination) -> Self {
        Self {
            query: request.query.clone(),
            pages: Vec::new(),
            output_bytes: 0,
            item_count: 0,
            next_cursor: request
                .query
                .get(&pagination.cursor_param)
                .and_then(JsonValue::as_str)
                .map(str::to_owned),
            last: None,
        }
    }

    fn prepare_page(&mut self, page_index: usize, pagination: &Pagination) -> bool {
        if page_index == 0 {
            return true;
        }
        let Some(cursor) = &self.next_cursor else {
            return false;
        };
        self.query.insert(
            pagination.cursor_param.clone(),
            JsonValue::String(cursor.clone()),
        );
        true
    }

    fn record(&mut self, page: JsonObject, pagination: &Pagination) -> Result<bool, RuntimeError> {
        self.output_bytes = self.output_bytes.saturating_add(estimated_size(&page)?);
        if self.output_bytes > MAX_HTTP_OUTPUT_BYTES {
            return Err(invalid(format!(
                "paginated HTTP output exceeded {MAX_HTTP_OUTPUT_BYTES} bytes"
            )));
        }
        let ok = page.get("ok").and_then(JsonValue::as_bool).unwrap_or(false);
        let status = page.get("status").and_then(json_u64).unwrap_or_default();
        let json = page.get("json").unwrap_or(&JsonValue::Null);
        self.item_count = self.item_count.saturating_add(
            value_at_path(json, &pagination.items_path)
                .and_then(JsonValue::as_array)
                .map(Vec::len)
                .unwrap_or_default(),
        );
        self.next_cursor = value_at_path(json, &pagination.cursor_path)
            .and_then(JsonValue::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        self.last = Some(page.clone());
        self.pages.push(JsonValue::Object(page));
        Ok(!ok
            || status == 429
            || self.next_cursor.is_none()
            || self.item_count >= pagination.max_items)
    }

    fn finish(self, request_id: &str) -> Result<JsonObject, RuntimeError> {
        let mut aggregate = self
            .last
            .ok_or_else(|| invalid(format!("request {request_id:?} produced no pages")))?;
        aggregate.insert(
            "page_count".to_owned(),
            JsonValue::Number(JsonNumber::U64(self.pages.len() as u64)),
        );
        aggregate.insert("pages".to_owned(), JsonValue::Array(self.pages));
        aggregate.insert(
            "item_count".to_owned(),
            JsonValue::Number(JsonNumber::U64(self.item_count as u64)),
        );
        aggregate.insert(
            "next_cursor".to_owned(),
            self.next_cursor.map_or(JsonValue::Null, JsonValue::String),
        );
        Ok(aggregate)
    }
}

pub(super) fn execute_paginated<T: RuntimeHttpTransport>(
    runtime: &RequestRuntime<'_, '_, T>,
    request_id: &str,
    request: &PreparedRequest,
    pagination: &Pagination,
) -> Result<JsonObject, RuntimeError> {
    if request.method != HttpMethod::Get || request.body.is_some() {
        return Err(invalid(format!(
            "request {request_id:?} pagination requires a bodyless GET"
        )));
    }
    let mut run = PaginationRun::new(request, pagination);
    for page_index in 0..pagination.max_pages {
        if !run.prepare_page(page_index, pagination) {
            break;
        }
        let page = runtime.send(request_id, request, &run.query, false)?;
        if run.record(page, pagination)? {
            break;
        }
    }
    run.finish(request_id)
}
