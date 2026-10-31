use serde::de::DeserializeOwned;

pub(crate) fn parse<T: DeserializeOwned>(json: &str) -> Option<T> {
    let mut escaped = String::with_capacity(json.len());
    let (mut in_string, mut after_slash) = (false, false);
    for ch in json.chars() {
        // Native 1.13.8 writes decoded newlines verbatim into JSON text and tokens.
        if in_string && ch <= '\u{1f}' {
            if after_slash {
                return None;
            }
            use std::fmt::Write;
            write!(escaped, "\\u{:04x}", ch as u32).unwrap();
            after_slash = false;
        } else {
            escaped.push(ch);
            if after_slash {
                after_slash = false;
            } else if in_string && ch == '\\' {
                after_slash = true;
            } else if ch == '"' {
                in_string = !in_string;
            }
        }
    }
    serde_json::from_str(&escaped).ok()
}

#[cfg(test)]
mod tests {
    use super::parse;
    use crate::OfflineRecognizerResult;

    #[test]
    fn decoded_controls_in_text_and_tokens_are_preserved() {
        let raw = "{\"text\":\"Tiếng Việt\n\t\r\u{1b}\",\"tokens\":[\"Việt\n\"]}";
        assert!(serde_json::from_str::<OfflineRecognizerResult>(raw).is_err());
        let result: OfflineRecognizerResult = parse(raw).unwrap();
        assert_eq!(result.text, "Tiếng Việt\n\t\r\u{1b}");
        assert_eq!(result.tokens, ["Việt\n"]);
    }

    #[test]
    fn valid_json_escapes_quotes_unicode_and_layout_are_unchanged() {
        let raw = concat!(
            "{\n",
            r#""text":"Việt \"quote\" \\ path\nnext","tokens":["\t","\u1ec7"]"#,
            "\n}"
        );
        let expected = serde_json::from_str::<OfflineRecognizerResult>(raw).unwrap();
        let result: OfflineRecognizerResult = parse(raw).unwrap();
        assert_eq!(result.text, expected.text);
        assert_eq!(result.tokens, expected.tokens);
    }

    #[test]
    fn malformed_results_remain_errors() {
        for raw in [
            r#"{"text":"oops}"#,
            r#"{"text":"bad\q","tokens":[]}"#,
            r#"{"text":5,"tokens":[]}"#,
            r#"{"text":"missing tokens"}"#,
            "{\u{1b}\"text\":\"x\",\"tokens\":[]}",
            "{\"text\":\"bad\\\n\",\"tokens\":[]}",
        ] {
            assert!(parse::<OfflineRecognizerResult>(raw).is_none());
        }
    }
}
