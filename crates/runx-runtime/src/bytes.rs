#[cfg(any(feature = "external-adapter", feature = "thread-outbox-provider"))]
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

pub(crate) fn truncate_utf8_bytes(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_owned();
    }
    let mut end = maximum;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::truncate_utf8_bytes;

    #[test]
    fn utf8_truncation_never_splits_a_character() {
        assert_eq!(truncate_utf8_bytes("ab🙂cd", 5), "ab");
        assert_eq!(truncate_utf8_bytes("ab🙂cd", 6), "ab🙂");
    }
}
