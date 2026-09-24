use regex::Regex;

use crate::youtube::YouTubeChallengeSolver;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransformOperation {
    Reverse,
    Drop(usize),
    Swap(usize),
    RotateLeft(usize),
    RotateRight(usize),
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
        apply_transform_operations(encrypted_signature, &operations)
    }

    fn transform_throttling_parameter(
        &self,
        player_javascript: &str,
        value: &str,
    ) -> Result<String, String> {
        let operations = extract_throttling_operations(player_javascript)?;
        apply_transform_operations(value, &operations)
    }
}


#[derive(Clone, Debug, Eq, PartialEq)]
enum ThrottlingTarget {
    Named(String),
    ArrayElement { array: String, index: usize },
}

fn extract_throttling_operations(script: &str) -> Result<Vec<TransformOperation>, String> {
    let target = locate_throttling_target(script)?;
    match target {
        ThrottlingTarget::Named(name) => {
            let (argument, body) = named_transform_function(script, &name)?
                .ok_or_else(|| format!("YouTube n-transform function {name} was not found"))?;
            let operations = parse_transform_body(script, body, &argument)?;
            if operations.is_empty() {
                return Err("YouTube n-transform contained no recognized transforms".to_owned());
            }
            Ok(operations)
        }
        ThrottlingTarget::ArrayElement { array, index } => {
            let (argument, body) = array_transform_function(script, &array, index)?;
            let operations = parse_transform_body(script, body, &argument)?;
            if operations.is_empty() {
                return Err("YouTube indexed n-transform contained no recognized transforms".to_owned());
            }
            Ok(operations)
        }
    }
}

fn locate_throttling_target(script: &str) -> Result<ThrottlingTarget, String> {
    let marker = Regex::new(
        r#"(?:\.get\(\s*["']n["']\s*\)|\.set\(\s*["']n["']\s*,|["']nn["']\s*\[)"#,
    )
    .map_err(|error| error.to_string())?;
    let named_call = Regex::new(
        r#"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)"#,
    )
    .map_err(|error| error.to_string())?;
    let indexed_call = Regex::new(
        r#"(?P<array>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*(?P<index>\d+)\s*\]\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)"#,
    )
    .map_err(|error| error.to_string())?;

    let mut candidates: Vec<(usize, ThrottlingTarget)> = Vec::new();
    for marker_match in marker.find_iter(script) {
        let start = marker_match.start().saturating_sub(512);
        let end = (marker_match.end() + 768).min(script.len());
        let Some(window) = script.get(start..end) else {
            continue;
        };

        for captures in indexed_call.captures_iter(window) {
            let Some(whole) = captures.get(0) else {
                continue;
            };
            let Some(array) = captures.name("array").map(|value| value.as_str()) else {
                continue;
            };
            let Some(index) = captures
                .name("index")
                .and_then(|value| value.as_str().parse::<usize>().ok())
            else {
                continue;
            };
            if array_transform_function(script, array, index).is_ok() {
                let absolute = start + whole.start();
                let distance = absolute.abs_diff(marker_match.start());
                candidates.push((
                    distance,
                    ThrottlingTarget::ArrayElement {
                        array: array.to_owned(),
                        index,
                    },
                ));
            }
        }

        for captures in named_call.captures_iter(window) {
            let Some(whole) = captures.get(0) else {
                continue;
            };
            let Some(name) = captures.name("name").map(|value| value.as_str()) else {
                continue;
            };
            if matches!(name, "get" | "set" | "encodeURIComponent" | "decodeURIComponent") {
                continue;
            }
            if named_transform_function(script, name)?.is_some() {
                let absolute = start + whole.start();
                let distance = absolute.abs_diff(marker_match.start());
                candidates.push((distance, ThrottlingTarget::Named(name.to_owned())));
            }
        }
    }

    candidates.sort_by_key(|(distance, _)| *distance);
    candidates.dedup_by(|left, right| left.1 == right.1);
    let Some((best_distance, best)) = candidates.first().cloned() else {
        return Err("unable to locate YouTube n-transform call site".to_owned());
    };
    if candidates
        .iter()
        .skip(1)
        .any(|(distance, target)| *distance == best_distance && *target != best)
    {
        return Err("ambiguous YouTube n-transform call site".to_owned());
    }
    Ok(best)
}

fn named_transform_function<'a>(
    script: &'a str,
    expected_name: &str,
) -> Result<Option<(String, &'a str)>, String> {
    let assignment = Regex::new(&format!(
        r#"{}\s*=\s*function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{{"#,
        regex::escape(expected_name)
    ))
    .map_err(|error| error.to_string())?;
    let declaration = Regex::new(&format!(
        r#"function\s+{}\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{{"#,
        regex::escape(expected_name)
    ))
    .map_err(|error| error.to_string())?;

    for captures in assignment
        .captures_iter(script)
        .chain(declaration.captures_iter(script))
    {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        let Some(argument) = captures.name("arg").map(|value| value.as_str().to_owned()) else {
            continue;
        };
        let brace = whole.end().saturating_sub(1);
        let Some(body) = balanced_block(script, brace, b'{', b'}') else {
            continue;
        };
        if transform_body_has_split_join(body, &argument) {
            return Ok(Some((argument, body)));
        }
    }
    Ok(None)
}

fn array_transform_function<'a>(
    script: &'a str,
    array: &str,
    index: usize,
) -> Result<(String, &'a str), String> {
    let pattern = Regex::new(&format!(
        r#"(?:(?:var|let|const)\s+)?{}\s*=\s*\["#,
        regex::escape(array)
    ))
    .map_err(|error| error.to_string())?;
    let array_match = pattern
        .find(script)
        .ok_or_else(|| format!("YouTube n-transform array {array} was not found"))?;
    let bracket = array_match.end().saturating_sub(1);
    let body = balanced_block(script, bracket, b'[', b']')
        .ok_or_else(|| format!("YouTube n-transform array {array} is malformed"))?;
    let entries = split_top_level(body, b',');
    let entry = entries
        .get(index)
        .map(|value| value.trim())
        .ok_or_else(|| format!("YouTube n-transform array index {array}[{index}] is missing"))?;

    let inline = Regex::new(
        r#"^function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    if let Some(captures) = inline.captures(entry) {
        let whole = captures
            .get(0)
            .ok_or_else(|| "inline n-transform function match is incomplete".to_owned())?;
        let argument = captures
            .name("arg")
            .map(|value| value.as_str().to_owned())
            .ok_or_else(|| "inline n-transform argument is missing".to_owned())?;
        let brace = whole.end().saturating_sub(1);
        let function_body = balanced_block(entry, brace, b'{', b'}')
            .ok_or_else(|| "inline n-transform function is malformed".to_owned())?;
        if !transform_body_has_split_join(function_body, &argument) {
            return Err("indexed n-transform does not split and join its input".to_owned());
        }
        let offset = entry.as_ptr() as usize - script.as_ptr() as usize;
        let body_offset = function_body.as_ptr() as usize - entry.as_ptr() as usize;
        let start = offset + body_offset;
        let end = start + function_body.len();
        let borrowed = script
            .get(start..end)
            .ok_or_else(|| "indexed n-transform source range is invalid".to_owned())?;
        return Ok((argument, borrowed));
    }

    if Regex::new(r#"^[A-Za-z_$][A-Za-z0-9_$]*$"#)
        .map_err(|error| error.to_string())?
        .is_match(entry)
    {
        return named_transform_function(script, entry)?
            .ok_or_else(|| format!("YouTube n-transform array target {entry} was not found"));
    }

    Err(format!(
        "unsupported YouTube n-transform array entry {array}[{index}]"
    ))
}

fn transform_body_has_split_join(body: &str, argument: &str) -> bool {
    (body.contains(&format!("{argument}.split(\"\")"))
        || body.contains(&format!("{argument}.split('')")))
        && (body.contains(&format!("{argument}.join(\"\")"))
            || body.contains(&format!("{argument}.join('')")))
}

fn split_top_level(source: &str, delimiter: u8) -> Vec<&str> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut start = 0usize;
    let mut braces = 0u32;
    let mut brackets = 0u32;
    let mut parentheses = 0u32;
    let mut in_string: Option<u8> = None;
    let mut escaped = false;

    for (index, byte) in bytes.iter().copied().enumerate() {
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
        match byte {
            b'{' => braces = braces.saturating_add(1),
            b'}' => braces = braces.saturating_sub(1),
            b'[' => brackets = brackets.saturating_add(1),
            b']' => brackets = brackets.saturating_sub(1),
            b'(' => parentheses = parentheses.saturating_add(1),
            b')' => parentheses = parentheses.saturating_sub(1),
            _ => {}
        }
        if byte == delimiter && braces == 0 && brackets == 0 && parentheses == 0 {
            if let Some(piece) = source.get(start..index) {
                output.push(piece);
            }
            start = index + 1;
        }
    }
    if let Some(piece) = source.get(start..) {
        output.push(piece);
    }
    output
}


fn extract_signature_operations(script: &str) -> Result<Vec<TransformOperation>, String> {
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
) -> Result<Vec<TransformOperation>, String> {
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
            operations.push(TransformOperation::Reverse);
            continue;
        }
        if let Some(captures) = direct_splice.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid direct YouTube splice amount".to_owned())?;
            operations.push(TransformOperation::Drop(amount));
            continue;
        }
        if let Some(captures) = direct_slice.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid direct YouTube slice amount".to_owned())?;
            operations.push(TransformOperation::Drop(amount));
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
) -> Result<TransformOperation, String> {
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
        return Ok(TransformOperation::Reverse);
    }
    if method_body.contains(".splice(0,") || method_body.contains(".slice(") {
        return Ok(TransformOperation::Drop(amount));
    }
    if method_body.contains("[0]")
        && method_body.contains(".length")
        && method_body.contains('%')
    {
        return Ok(TransformOperation::Swap(amount));
    }

    Err(format!(
        "unsupported YouTube signature helper method {object}.{method}"
    ))
}

fn apply_transform_operations(
    input: &str,
    operations: &[TransformOperation],
) -> Result<String, String> {
    let mut bytes = input.as_bytes().to_vec();

    for operation in operations {
        match *operation {
            TransformOperation::Reverse => bytes.reverse(),
            TransformOperation::Drop(amount) => {
                let amount = amount.min(bytes.len());
                bytes.drain(..amount);
            }
            TransformOperation::Swap(amount) => {
                if bytes.is_empty() {
                    return Err("cannot swap an empty YouTube transform input".to_owned());
                }
                let index = amount % bytes.len();
                bytes.swap(0, index);
            }
            TransformOperation::RotateLeft(amount) => {
                if !bytes.is_empty() {
                    let len = bytes.len();
                    bytes.rotate_left(amount % len);
                }
            }
            TransformOperation::RotateRight(amount) => {
                if !bytes.is_empty() {
                    let len = bytes.len();
                    bytes.rotate_right(amount % len);
                }
            }
        }
    }

    String::from_utf8(bytes)
        .map_err(|_| "YouTube transform produced invalid UTF-8".to_owned())
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
