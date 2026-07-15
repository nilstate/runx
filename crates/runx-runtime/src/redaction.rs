pub fn redact_sensitive_text(input: &str) -> String {
    redact_urls(&redact_bearer_tokens(&redact_prefixed_secret(
        input, "SECRET_",
    )))
}

#[cfg(any(feature = "thread-outbox-provider", feature = "external-adapter"))]
pub(crate) fn trim_ascii_whitespace(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(start, |index| index + 1);
    &bytes[start..end]
}

fn redact_prefixed_secret(input: &str, prefix: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative_start) = input[index..].find(prefix) {
        let start = index + relative_start;
        output.push_str(&input[index..start]);
        let mut end = start + prefix.len();
        for character in input[end..].chars() {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                end += character.len_utf8();
            } else {
                break;
            }
        }
        output.push_str("[redacted]");
        index = end;
    }
    output.push_str(&input[index..]);
    output
}

fn redact_bearer_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative_start) = input[index..].find("Bearer ") {
        let start = index + relative_start;
        output.push_str(&input[index..start]);
        output.push_str("Bearer [redacted]");
        let mut end = start + "Bearer ".len();
        for character in input[end..].chars() {
            if character.is_whitespace() {
                break;
            }
            end += character.len_utf8();
        }
        index = end;
    }
    output.push_str(&input[index..]);
    output
}

fn redact_urls(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative_start) = find_next_url(&input[index..]) {
        let start = index + relative_start;
        output.push_str(&input[index..start]);
        output.push_str("[redacted-url]");
        let mut end = start;
        for character in input[end..].chars() {
            if character.is_whitespace() || matches!(character, '"' | '\'' | ')' | ']') {
                break;
            }
            end += character.len_utf8();
        }
        index = end;
    }
    output.push_str(&input[index..]);
    output
}

fn find_next_url(input: &str) -> Option<usize> {
    match (input.find("https://"), input.find("http://")) {
        (Some(https), Some(http)) => Some(https.min(http)),
        (Some(https), None) => Some(https),
        (None, Some(http)) => Some(http),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::redact_sensitive_text;

    #[test]
    fn redacts_sentinel_and_bearer_values() {
        let redacted = redact_sensitive_text(
            "failed SECRET_PROVIDER_ACCESS_TOKEN_DO_NOT_LEAK Bearer abc.def SECRET_AUTHORIZE_QUERY_DO_NOT_LEAK https://auth.example/authorize?code=abc",
        );

        assert!(!redacted.contains("SECRET_PROVIDER_ACCESS_TOKEN_DO_NOT_LEAK"));
        assert!(!redacted.contains("abc.def"));
        assert!(!redacted.contains("SECRET_AUTHORIZE_QUERY_DO_NOT_LEAK"));
        assert!(!redacted.contains("auth.example"));
        assert_eq!(
            redacted,
            "failed [redacted] Bearer [redacted] [redacted] [redacted-url]"
        );
    }
}
