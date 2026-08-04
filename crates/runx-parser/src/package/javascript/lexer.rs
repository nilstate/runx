use super::SkillPackageError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Token {
    Ident(String),
    String { value: String, escaped: bool },
    Punct(char),
}

pub(super) fn tokenize(path: &str, source: &str) -> Result<Vec<Token>, SkillPackageError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'#' if index == 0 && bytes.get(1) == Some(&b'!') => {
                index = 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                let start = index;
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                if index + 1 >= bytes.len() {
                    return Err(SkillPackageError::invalid(
                        path,
                        format!("unterminated JavaScript block comment at byte {start}"),
                    ));
                }
                index += 2;
            }
            b'/' if regex_can_start_after(tokens.last()) => {
                index = skip_regex(path, bytes, index)?;
            }
            quote @ (b'\'' | b'\"') => {
                let (token, next) = string_token(path, bytes, index, quote)?;
                tokens.push(token);
                index = next;
            }
            b'`' => index = skip_template(path, bytes, index)?,
            byte if is_ident_start(byte) => {
                let start = index;
                index += 1;
                while index < bytes.len() && is_ident_continue(bytes[index]) {
                    index += 1;
                }
                let value = std::str::from_utf8(&bytes[start..index]).map_err(|error| {
                    SkillPackageError::invalid(path, format!("invalid UTF-8 identifier: {error}"))
                })?;
                tokens.push(Token::Ident(value.to_owned()));
            }
            byte => {
                tokens.push(Token::Punct(char::from(byte)));
                index += 1;
            }
        }
    }
    Ok(tokens)
}

fn regex_can_start_after(previous: Option<&Token>) -> bool {
    match previous {
        None => true,
        Some(Token::Punct(character)) => REGEX_PREFIX_PUNCTUATION.contains(character),
        Some(Token::Ident(keyword)) => REGEX_PREFIX_KEYWORDS.contains(&keyword.as_str()),
        Some(Token::String { .. }) => false,
    }
}

const REGEX_PREFIX_PUNCTUATION: &[char] = &[
    '(', '[', '{', ',', ';', ':', '=', '!', '?', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>',
];

const REGEX_PREFIX_KEYWORDS: &[&str] = &[
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
];

fn skip_regex(path: &str, bytes: &[u8], start: usize) -> Result<usize, SkillPackageError> {
    let mut index = start + 1;
    let mut in_character_class = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.saturating_add(2),
            b'[' if !in_character_class => {
                in_character_class = true;
                index += 1;
            }
            b']' if in_character_class => {
                in_character_class = false;
                index += 1;
            }
            b'/' if !in_character_class => {
                index += 1;
                while index < bytes.len() && is_ident_continue(bytes[index]) {
                    index += 1;
                }
                return Ok(index);
            }
            b'\n' | b'\r' => {
                return Err(SkillPackageError::invalid(
                    path,
                    format!("unterminated JavaScript regular expression at byte {start}"),
                ));
            }
            _ => index += 1,
        }
    }
    Err(SkillPackageError::invalid(
        path,
        format!("unterminated JavaScript regular expression at byte {start}"),
    ))
}

fn string_token(
    path: &str,
    bytes: &[u8],
    start: usize,
    quote: u8,
) -> Result<(Token, usize), SkillPackageError> {
    let mut index = start + 1;
    let mut escaped = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                escaped = true;
                index = index.saturating_add(2);
            }
            byte if byte == quote => {
                let value = std::str::from_utf8(&bytes[start + 1..index]).map_err(|error| {
                    SkillPackageError::invalid(path, format!("invalid UTF-8 string: {error}"))
                })?;
                return Ok((
                    Token::String {
                        value: value.to_owned(),
                        escaped,
                    },
                    index + 1,
                ));
            }
            b'\n' | b'\r' => {
                return Err(SkillPackageError::invalid(
                    path,
                    format!("unterminated JavaScript string at byte {start}"),
                ));
            }
            _ => index += 1,
        }
    }
    Err(SkillPackageError::invalid(
        path,
        format!("unterminated JavaScript string at byte {start}"),
    ))
}

fn skip_template(path: &str, bytes: &[u8], start: usize) -> Result<usize, SkillPackageError> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.saturating_add(2),
            b'`' => return Ok(index + 1),
            _ => index += 1,
        }
    }
    Err(SkillPackageError::invalid(
        path,
        format!("unterminated JavaScript template literal at byte {start}"),
    ))
}

const fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

const fn is_ident_continue(byte: u8) -> bool {
    is_ident_start(byte) || byte.is_ascii_digit()
}
