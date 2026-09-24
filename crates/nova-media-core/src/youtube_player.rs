use regex::Regex;

use crate::youtube::YouTubeChallengeSolver;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SignatureOperation {
    Reverse,
    Drop(usize),
    Swap(usize),
}

/// Pure-Rust parser/executor for the compact signature transform used by the
/// YouTube player.
///
/// Unknown helper methods fail closed instead of guessing.
#[derive(Clone, Copy, Debug, Default)]
pub struct YouTubePlayerScriptSolver;

impl YouTubeChallengeSolver for YouTubePlayerScriptSolver {
    fn decipher_signature(
        &self,
        player_javascript: &str,
        encrypted_signature: &str,
    ) -> Result<String, String> {
        let operations = extract_signature_operations(player_javascript)?;
        apply_signature_operations(encrypted_signature, &operations)
    }

    fn transform_throttling_parameter(
        &self,
        _player_javascript: &str,
        _value: &str,
    ) -> Result<String, String> {
        Err("native YouTube n-transform parser is not implemented yet".to_owned())
    }
}

fn extract_signature_operations(script: &str) -> Result<Vec<SignatureOperation>, String> {
    let assignment = Regex::new(
        r#"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    let declaration = Regex::new(
        r#"function\s+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;

    for captures in assignment.captures_iter(script).chain(declaration.captures_iter(script)) {
        let whole = captures
            .get(0)
            .ok_or_else(|| "signature function match is incomplete".to_owned())?;
        let arg = captures
            .name("arg")
            .map(|value| value.as_str())
            .ok_or_else(|| "signature function argument is missing".to_owned())?;
        let brace = whole.end().saturating_sub(1);
        let Some(body) = balanced_block(script, brace, b'{', b'}') else {
            continue;
        };

        if !body.contains(&format!("{arg}.split(\"\")"))
            && !body.contains(&format!("{arg}.split('')"))
        {
            continue;
        }
        if !body.contains(&format!("{arg}.join(\"\")"))
            && !body.contains(&format!("{arg}.join('')"))
        {
            continue;
        }

        let operations = parse_transform_body(script, body, arg)?;
        if operations.is_empty() {
            return Err("YouTube signature function contained no recognized transforms".to_owned());
        }
        return Ok(operations);
    }

    Err("unable to locate YouTube signature transform function".to_owned())
}

fn parse_transform_body(
    script: &str,
    body: &str,
    argument: &str,
) -> Result<Vec<SignatureOperation>, String> {
    let helper_call = Regex::new(
        r#"(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\.(?P<method>[A-Za-z_$][A-Za-z0-9_$]*)\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)(?:,(?P<value>\d+))?\)"#,
    )
    .map_err(|error| error.to_string())?;
    let direct_splice = Regex::new(&format!(
        r#"{}\s*\.splice\(0,\s*(\d+)\)"#,
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;
    let direct_slice = Regex::new(&format!(
        r#"{}\s*=\s*{}\s*\.slice\(\s*(\d+)\s*\)"#,
        regex::escape(argument),
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;

    let mut operations = Vec::new();
    for statement in body.split(';').map(str::trim).filter(|part| !part.is_empty()) {
        if statement.contains(".split(") || statement.contains(".join(") || statement.starts_with("return ") {
            continue;
        }

        if statement.contains(&format!("{argument}.reverse()")) {
            operations.push(SignatureOperation::Reverse);
            continue;
        }
        if let Some(captures) = direct_splice.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid direct YouTube splice amount".to_owned())?;
            operations.push(SignatureOperation::Drop(amount));
            continue;
        }
        if let Some(captures) = direct_slice.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid direct YouTube slice amount".to_owned())?;
            operations.push(SignatureOperation::Drop(amount));
            continue;
        }

        if let Some(captures) = helper_call.captures(statement) {
            if captures.name("arg").map(|value| value.as_str()) != Some(argument) {
                continue;
            }
            let object = captures
                .name("object")
                .map(|value| value.as_str())
                .ok_or_else(|| "YouTube signature helper object is missing".to_owned())?;
            let method = captures
                .name("method")
                .map(|value| value.as_str())
                .ok_or_else(|| "YouTube signature helper method is missing".to_owned())?;
            let amount = captures
                .name("value")
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            operations.push(classify_helper_operation(script, object, method, amount)?);
            continue;
        }

        if statement.starts_with("var ")
            || statement.starts_with("let ")
            || statement.starts_with("const ")
        {
            continue;
        }

        return Err(format!(
            "unsupported statement in YouTube signature function: {statement}"
        ));
    }

    Ok(operations)
}

fn classify_helper_operation(
    script: &str,
    object: &str,
    method: &str,
    amount: usize,
) -> Result<SignatureOperation, String> {
    let object_pattern = Regex::new(&format!(
        r#"(?:(?:var|let|const)\s+)?{}\s*=\s*\{{"#,
        regex::escape(object)
    ))
    .map_err(|error| error.to_string())?;
    let object_match = object_pattern
        .find(script)
        .ok_or_else(|| format!("YouTube signature helper object {object} was not found"))?;
    let brace = object_match.end().saturating_sub(1);
    let object_body = balanced_block(script, brace, b'{', b'}')
        .ok_or_else(|| format!("YouTube signature helper object {object} is malformed"))?;

    let method_pattern = Regex::new(&format!(
        r#"{}\s*:\s*function\([^)]*\)\s*\{{"#,
        regex::escape(method)
    ))
    .map_err(|error| error.to_string())?;
    let method_match = method_pattern
        .find(object_body)
        .ok_or_else(|| format!("YouTube signature helper method {object}.{method} was not found"))?;
    let relative_brace = method_match.end().saturating_sub(1);
    let method_body = balanced_block(object_body, relative_brace, b'{', b'}')
        .ok_or_else(|| format!("YouTube signature helper method {object}.{method} is malformed"))?;

    if method_body.contains(".reverse(") {
        return Ok(SignatureOperation::Reverse);
    }
    if method_body.contains(".splice(0,") || method_body.contains(".slice(") {
        return Ok(SignatureOperation::Drop(amount));
    }
    if method_body.contains("[0]")
        && method_body.contains(".length")
        && method_body.contains('%')
    {
        return Ok(SignatureOperation::Swap(amount));
    }

    Err(format!(
        "unsupported YouTube signature helper method {object}.{method}"
    ))
}

fn apply_signature_operations(
    signature: &str,
    operations: &[SignatureOperation],
) -> Result<String, String> {
    let mut bytes = signature.as_bytes().to_vec();

    for operation in operations {
        match *operation {
            SignatureOperation::Reverse => bytes.reverse(),
            SignatureOperation::Drop(amount) => {
                let amount = amount.min(bytes.len());
                bytes.drain(..amount);
            }
            SignatureOperation::Swap(amount) => {
                if bytes.is_empty() {
                    return Err("cannot swap an empty YouTube signature".to_owned());
                }
                let index = amount % bytes.len();
                bytes.swap(0, index);
            }
        }
    }

    String::from_utf8(bytes)
        .map_err(|_| "YouTube signature transform produced invalid UTF-8".to_owned())
}

fn balanced_block(
    source: &str,
    opening_index: usize,
    open: u8,
    close: u8,
) -> Option<&str> {
    let bytes = source.as_bytes();
    if bytes.get(opening_index) != Some(&open) {
        return None;
    }

    let mut depth = 0_u32;
    let mut in_string: Option<u8> = None;
    let mut escaped = false;

    for index in opening_index..bytes.len() {
        let byte = bytes[index];
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                in_string = None;
            }
            continue;
        }

        if matches!(byte, b'"' | b'\'') || byte == 96 {
            in_string = Some(byte);
            continue;
        }

        if byte == open {
            depth = depth.saturating_add(1);
        } else if byte == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return source.get(opening_index + 1..index);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::youtube::YouTubeChallengeSolver;

    #[test]
    fn extracts_and_executes_classic_signature_operations() {
        let player = r#"
var ZZ={
Rv:function(a){a.reverse()},
Sp:function(a,b){a.splice(0,b)},
Sw:function(a,b){var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c}
};
AB=function(a){a=a.split("");ZZ.Sw(a,2);ZZ.Rv(a);ZZ.Sp(a,1);return a.join("")};
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("signature"),
            "edabc"
        );
    }

    #[test]
    fn rejects_unknown_helper_instead_of_guessing() {
        let player = r#"
var ZZ={XX:function(a,b){a.push(b)}};
AB=function(a){a=a.split("");ZZ.XX(a,2);return a.join("")};
"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver.decipher_signature(player, "abcdef").is_err());
    }

    #[test]
    fn supports_direct_reverse_and_slice() {
        let player =
            r#"AB=function(a){a=a.split("");a.reverse();a=a.slice(2);return a.join("")};"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("signature"),
            "dcba"
        );
    }

    #[test]
    fn n_transform_fails_closed_until_native_parser_is_added() {
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter("player", "abc")
            .is_err());
    }
}
