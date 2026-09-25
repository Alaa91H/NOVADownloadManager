use std::collections::{hash_map::DefaultHasher, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use regex::Regex;

use crate::youtube::YouTubeChallengeSolver;

const PLAYER_SCRIPT_PARSE_CACHE_SIZE: usize = 8;
const PLAYER_SCRIPT_MAX_BYTES: usize = 8 * 1024 * 1024;

type TransformPlan = Vec<TransformOperation>;
type TransformPlanCache = OnceLock<Mutex<VecDeque<(u64, TransformPlan)>>>;

static SIGNATURE_PLAN_CACHE: TransformPlanCache = OnceLock::new();
static THROTTLING_PLAN_CACHE: TransformPlanCache = OnceLock::new();

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
        let operations = cached_signature_operations(player_javascript)?;
        match apply_transform_operations(encrypted_signature, &operations) {
            Ok(transformed) => Ok(transformed),
            Err(error) => {
                invalidate_plan(&SIGNATURE_PLAN_CACHE, player_javascript);
                Err(error)
            }
        }
    }

    fn transform_throttling_parameter(
        &self,
        player_javascript: &str,
        value: &str,
    ) -> Result<String, String> {
        let operations = cached_throttling_operations(player_javascript)?;
        match apply_transform_operations(value, &operations) {
            Ok(transformed) => Ok(transformed),
            Err(error) => {
                invalidate_plan(&THROTTLING_PLAN_CACHE, player_javascript);
                Err(error)
            }
        }
    }
}


#[derive(Clone, Debug, Eq, PartialEq)]
enum ThrottlingTarget {
    Named(String),
    ArrayElement { array: String, index: usize },
}


fn cached_signature_operations(script: &str) -> Result<Vec<TransformOperation>, String> {
    cached_operations(&SIGNATURE_PLAN_CACHE, script, extract_signature_operations)
}

fn cached_operations(
    cache: &'static TransformPlanCache,
    script: &str,
    extractor: fn(&str) -> Result<Vec<TransformOperation>, String>,
) -> Result<Vec<TransformOperation>, String> {
    if script.len() > PLAYER_SCRIPT_MAX_BYTES {
        return Err(format!(
            "YouTube player script exceeds native parser limit of {PLAYER_SCRIPT_MAX_BYTES} bytes"
        ));
    }

    let key = player_script_cache_key(script);
    let cache = cache.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Ok(cache) = cache.lock() {
        if let Some((_, operations)) = cache.iter().find(|(cached, _)| *cached == key) {
            return Ok(operations.clone());
        }
    }

    let operations = extractor(script)?;
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= PLAYER_SCRIPT_PARSE_CACHE_SIZE {
            cache.pop_front();
        }
        cache.push_back((key, operations.clone()));
    }
    Ok(operations)
}

fn cached_throttling_operations(script: &str) -> Result<Vec<TransformOperation>, String> {
    cached_operations(
        &THROTTLING_PLAN_CACHE,
        script,
        extract_throttling_operations,
    )
}

fn player_script_cache_key(script: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    script.hash(&mut hasher);
    hasher.finish()
}

fn invalidate_plan(
    cache: &'static TransformPlanCache,
    script: &str,
) {
    let key = player_script_cache_key(script);
    let Some(cache) = cache.get() else {
        return;
    };
    if let Ok(mut cache) = cache.lock() {
        cache.retain(|(cached, _)| *cached != key);
    }
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

    let arrow_parenthesized = Regex::new(&format!(
        r#"{}\s*=\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>\s*\{{"#,
        regex::escape(expected_name)
    ))
    .map_err(|error| error.to_string())?;
    let arrow_single = Regex::new(&format!(
        r#"{}\s*=\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{{"#,
        regex::escape(expected_name)
    ))
    .map_err(|error| error.to_string())?;

    for captures in assignment
        .captures_iter(script)
        .chain(declaration.captures_iter(script))
        .chain(arrow_parenthesized.captures_iter(script))
        .chain(arrow_single.captures_iter(script))
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
        if let Some(working) = transform_working_variable(body, &argument)? {
            return Ok(Some((working, body)));
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

    let inline_function = Regex::new(
        r#"^function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    let inline_arrow_parenthesized = Regex::new(
        r#"^\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    let inline_arrow_single = Regex::new(
        r#"^(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    if let Some(captures) = inline_function
        .captures(entry)
        .or_else(|| inline_arrow_parenthesized.captures(entry))
        .or_else(|| inline_arrow_single.captures(entry))
    {
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
        let working = transform_working_variable(function_body, &argument)?
            .ok_or_else(|| "indexed n-transform does not split and join its input".to_owned())?;
        let offset = entry.as_ptr() as usize - script.as_ptr() as usize;
        let body_offset = function_body.as_ptr() as usize - entry.as_ptr() as usize;
        let start = offset + body_offset;
        let end = start + function_body.len();
        let borrowed = script
            .get(start..end)
            .ok_or_else(|| "indexed n-transform source range is invalid".to_owned())?;
        return Ok((working, borrowed));
    }

    if Regex::new(r#"^[A-Za-z_$][A-Za-z0-9_$]*$"#)
        .map_err(|error| error.to_string())?
        .is_match(entry)
    {
        return named_transform_function(script, entry)?
            .ok_or_else(|| format!("YouTube n-transform array target {entry} was not found"));
    }

    let member = Regex::new(
        r#"^(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(?P<method>[A-Za-z_$][A-Za-z0-9_$]*)$"#,
    )
    .map_err(|error| error.to_string())?;
    let bracket_member = Regex::new(
        r#"^(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*["'](?P<method>[A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]$"#,
    )
    .map_err(|error| error.to_string())?;
    if let Some(captures) = member
        .captures(entry)
        .or_else(|| bracket_member.captures(entry))
    {
        let object = captures
            .name("object")
            .map(|value| value.as_str())
            .ok_or_else(|| "YouTube n-transform member object is missing".to_owned())?;
        let method = captures
            .name("method")
            .map(|value| value.as_str())
            .ok_or_else(|| "YouTube n-transform member method is missing".to_owned())?;
        return object_transform_function(script, object, method)?
            .ok_or_else(|| format!("YouTube n-transform array target {entry} was not found"));
    }

    Err(format!(
        "unsupported YouTube n-transform array entry {array}[{index}]"
    ))
}

fn object_transform_function<'a>(
    script: &'a str,
    object: &str,
    method: &str,
) -> Result<Option<(String, &'a str)>, String> {
    let object_pattern = Regex::new(&format!(
        r#"(?:(?:var|let|const)\s+)?{}\s*=\s*\{{"#,
        regex::escape(object)
    ))
    .map_err(|error| error.to_string())?;
    let Some(object_match) = object_pattern.find(script) else {
        return Ok(None);
    };
    let brace = object_match.end().saturating_sub(1);
    let object_body = balanced_block(script, brace, b'{', b'}')
        .ok_or_else(|| format!("YouTube transform object {object} is malformed"))?;

    let patterns = [
        Regex::new(&format!(
            r#"(?:"|')?{}(?:"|')?\s*:\s*function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{{"#,
            regex::escape(method)
        )),
        Regex::new(&format!(
            r#"(?:"|')?{}(?:"|')?\s*:\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>\s*\{{"#,
            regex::escape(method)
        )),
        Regex::new(&format!(
            r#"(?:"|')?{}(?:"|')?\s*:\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{{"#,
            regex::escape(method)
        )),
        Regex::new(&format!(
            r#"(?:"|')?{}(?:"|')?\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{{"#,
            regex::escape(method)
        )),
    ];

    for pattern in patterns {
        let pattern = pattern.map_err(|error| error.to_string())?;
        for captures in pattern.captures_iter(object_body) {
            let Some(whole) = captures.get(0) else {
                continue;
            };
            let Some(argument) = captures.name("arg").map(|value| value.as_str().to_owned()) else {
                continue;
            };
            let method_brace = whole.end().saturating_sub(1);
            let Some(body) = balanced_block(object_body, method_brace, b'{', b'}') else {
                continue;
            };
            if let Some(working) = transform_working_variable(body, &argument)? {
                return Ok(Some((working, body)));
            }
        }
    }

    Ok(None)
}

fn transform_working_variable(
    body: &str,
    input_argument: &str,
) -> Result<Option<String>, String> {
    let split = Regex::new(&format!(
        r#"(?:(?:var|let|const)\s+)?(?P<work>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*{}\.split\(\s*["']{{2}}\s*\)"#,
        regex::escape(input_argument)
    ))
    .map_err(|error| error.to_string())?;

    if let Some(captures) = split.captures(body) {
        let working = captures
            .name("work")
            .map(|value| value.as_str().to_owned())
            .ok_or_else(|| "YouTube transform split target is missing".to_owned())?;
        if body.contains(&format!("{working}.join(\"\")"))
            || body.contains(&format!("{working}.join('')"))
        {
            return Ok(Some(working));
        }
    }

    if (body.contains(&format!("{input_argument}.split(\"\")"))
        || body.contains(&format!("{input_argument}.split('')")))
        && (body.contains(&format!("{input_argument}.join(\"\")"))
            || body.contains(&format!("{input_argument}.join('')")))
    {
        return Ok(Some(input_argument.to_owned()));
    }

    Ok(None)
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

fn transform_statements(body: &str) -> Vec<&str> {
    let mut statements = Vec::new();
    for semicolon_group in split_top_level(body, b';') {
        let semicolon_group = semicolon_group.trim();
        if semicolon_group.starts_with("return ") {
            if !semicolon_group.is_empty() {
                statements.push(semicolon_group);
            }
            continue;
        }
        for comma_group in split_top_level(semicolon_group, b',') {
            let statement = comma_group.trim();
            if !statement.is_empty() {
                statements.push(statement);
            }
        }
    }
    statements
}

fn extract_signature_operations(script: &str) -> Result<Vec<TransformOperation>, String> {
    let throttling_target = locate_throttling_target(script).ok();
    let assignment = Regex::new(
        r#"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*function\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    let declaration = Regex::new(
        r#"function\s+(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\((?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;

    let throttling_body_ptr = match throttling_target.as_ref() {
        Some(ThrottlingTarget::ArrayElement { array, index }) => {
            array_transform_function(script, array, *index)
                .ok()
                .map(|(_, body)| body.as_ptr() as usize)
        }
        _ => None,
    };
    let arrow_parenthesized = Regex::new(
        r#"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*=>\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    let arrow_single = Regex::new(
        r#"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*\{"#,
    )
    .map_err(|error| error.to_string())?;

    for captures in assignment
        .captures_iter(script)
        .chain(declaration.captures_iter(script))
        .chain(arrow_parenthesized.captures_iter(script))
        .chain(arrow_single.captures_iter(script))
    {
        let whole = captures
            .get(0)
            .ok_or_else(|| "signature function match is incomplete".to_owned())?;
        let name = captures
            .name("name")
            .map(|value| value.as_str())
            .ok_or_else(|| "signature function name is missing".to_owned())?;
        if matches!(
            throttling_target.as_ref(),
            Some(ThrottlingTarget::Named(target)) if target == name
        ) {
            continue;
        }
        let arg = captures
            .name("arg")
            .map(|value| value.as_str())
            .ok_or_else(|| "signature function argument is missing".to_owned())?;
        let brace = whole.end().saturating_sub(1);
        let Some(body) = balanced_block(script, brace, b'{', b'}') else {
            continue;
        };
        if throttling_body_ptr == Some(body.as_ptr() as usize) {
            continue;
        }

        let Some(working) = transform_working_variable(body, arg)? else {
            continue;
        };

        let operations = parse_transform_body(script, body, &working)?;
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
    let indexed_helper_call = Regex::new(
        r#"(?P<array>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*(?P<index>\d+)\s*\]\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*(?P<value>\d+))?\s*\)"#,
    )
    .map_err(|error| error.to_string())?;
    let bracket_helper_call = Regex::new(
        r#"(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*["'](?P<method>[A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]\s*\(\s*(?P<arg>[A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*(?P<value>\d+))?\s*\)"#,
    )
    .map_err(|error| error.to_string())?;
    let undefined_guard = Regex::new(
        r#"^if\s*\(\s*typeof\s+[A-Za-z_$][A-Za-z0-9_$]*\s*={2,3}\s*["']undefined["']\s*\)\s*return\s+[A-Za-z_$][A-Za-z0-9_$]*$"#,
    )
    .map_err(|error| error.to_string())?;
    let rotate_left_apply = Regex::new(&format!(
        r#"{}\.push\.apply\(\s*{},\s*{}\.splice\(0,\s*(\d+)\)\s*\)"#,
        regex::escape(argument),
        regex::escape(argument),
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;
    let rotate_left_spread = Regex::new(&format!(
        r#"{}\.push\(\s*\.\.\.{}\.splice\(0,\s*(\d+)\)\s*\)"#,
        regex::escape(argument),
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;
    let rotate_right_apply = Regex::new(&format!(
        r#"{}\.unshift\.apply\(\s*{},\s*{}\.splice\(\s*-\s*(\d+)\s*,\s*\d+\s*\)\s*\)"#,
        regex::escape(argument),
        regex::escape(argument),
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;
    let rotate_right_spread = Regex::new(&format!(
        r#"{}\.unshift\(\s*\.\.\.{}\.splice\(\s*-\s*(\d+)\s*,\s*\d+\s*\)\s*\)"#,
        regex::escape(argument),
        regex::escape(argument)
    ))
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
    let split_initialization = Regex::new(&format!(
        r#"^(?:(?:var|let|const)\s+)?{}\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\.split\(\s*["']{{2}}\s*\)$"#,
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;
    let join_finalization = Regex::new(&format!(
        r#"^(?:return\s+)?{}\.join\(\s*["']{{2}}\s*\)$"#,
        regex::escape(argument)
    ))
    .map_err(|error| error.to_string())?;

    let mut operations = Vec::new();
    for statement in transform_statements(body) {
        if undefined_guard.is_match(statement)
            || split_initialization.is_match(statement)
            || join_finalization.is_match(statement)
        {
            continue;
        }
        if statement.contains(".split(") {
            return Err(format!(
                "unsupported split statement in YouTube transform function: {statement}"
            ));
        }
        if statement.contains(".join(") {
            return Err(format!(
                "unsupported join statement in YouTube transform function: {statement}"
            ));
        }
        if statement.starts_with("return ") {
            return Err(format!(
                "unsupported return statement in YouTube transform function: {statement}"
            ));
        }

        if statement.contains(&format!("{argument}.reverse()")) {
            operations.push(TransformOperation::Reverse);
            continue;
        }
        if statement.contains(&format!("{argument}.push({argument}.shift())")) {
            operations.push(TransformOperation::RotateLeft(1));
            continue;
        }
        if statement.contains(&format!("{argument}.unshift({argument}.pop())")) {
            operations.push(TransformOperation::RotateRight(1));
            continue;
        }
        if let Some(captures) = rotate_left_apply.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid YouTube rotate-left amount".to_owned())?;
            operations.push(TransformOperation::RotateLeft(amount));
            continue;
        }
        if let Some(captures) = rotate_left_spread.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid YouTube rotate-left amount".to_owned())?;
            operations.push(TransformOperation::RotateLeft(amount));
            continue;
        }
        if let Some(captures) = rotate_right_apply.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid YouTube rotate-right amount".to_owned())?;
            operations.push(TransformOperation::RotateRight(amount));
            continue;
        }
        if let Some(captures) = rotate_right_spread.captures(statement) {
            let amount = captures
                .get(1)
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "invalid YouTube rotate-right amount".to_owned())?;
            operations.push(TransformOperation::RotateRight(amount));
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

        if let Some(captures) = indexed_helper_call.captures(statement) {
            if captures.name("arg").map(|value| value.as_str()) != Some(argument) {
                continue;
            }
            let array = captures
                .name("array")
                .map(|value| value.as_str())
                .ok_or_else(|| "YouTube transform helper array is missing".to_owned())?;
            let index = captures
                .name("index")
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .ok_or_else(|| "YouTube transform helper array index is invalid".to_owned())?;
            let amount = captures
                .name("value")
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            operations.push(classify_array_helper_operation(script, array, index, amount)?);
            continue;
        }

        if let Some(captures) = bracket_helper_call.captures(statement) {
            if captures.name("arg").map(|value| value.as_str()) != Some(argument) {
                continue;
            }
            let object = captures
                .name("object")
                .map(|value| value.as_str())
                .ok_or_else(|| "YouTube transform helper object is missing".to_owned())?;
            let method = captures
                .name("method")
                .map(|value| value.as_str())
                .ok_or_else(|| "YouTube transform helper method is missing".to_owned())?;
            let amount = captures
                .name("value")
                .and_then(|value| value.as_str().parse::<usize>().ok())
                .unwrap_or(0);
            operations.push(classify_helper_operation(script, object, method, amount)?);
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
            "unsupported statement in YouTube transform function: {statement}"
        ));
    }

    Ok(operations)
}


fn classify_array_helper_operation(
    script: &str,
    array: &str,
    index: usize,
    amount: usize,
) -> Result<TransformOperation, String> {
    let pattern = Regex::new(&format!(
        r#"(?:(?:var|let|const)\s+)?{}\s*=\s*\["#,
        regex::escape(array)
    ))
    .map_err(|error| error.to_string())?;
    let array_match = pattern
        .find(script)
        .ok_or_else(|| format!("YouTube transform helper array {array} was not found"))?;
    let bracket = array_match.end().saturating_sub(1);
    let array_body = balanced_block(script, bracket, b'[', b']')
        .ok_or_else(|| format!("YouTube transform helper array {array} is malformed"))?;
    let entries = split_top_level(array_body, b',');
    let entry = entries
        .get(index)
        .map(|value| value.trim())
        .ok_or_else(|| format!("YouTube transform helper {array}[{index}] is missing"))?;
    let function = Regex::new(
        r#"^(?:function\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)\s*\{"#,
    )
    .map_err(|error| error.to_string())?;
    if let Some(function_match) = function.find(entry) {
        let brace = function_match.end().saturating_sub(1);
        let method_body = balanced_block(entry, brace, b'{', b'}')
            .ok_or_else(|| format!("YouTube transform helper {array}[{index}] is malformed"))?;
        return classify_operation_body(method_body, amount).ok_or_else(|| {
            format!("unsupported YouTube transform helper {array}[{index}]")
        });
    }

    let member = Regex::new(
        r#"^(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(?P<method>[A-Za-z_$][A-Za-z0-9_$]*)$"#,
    )
    .map_err(|error| error.to_string())?;
    let bracket_member = Regex::new(
        r#"^(?P<object>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*["'](?P<method>[A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]$"#,
    )
    .map_err(|error| error.to_string())?;
    if let Some(captures) = member
        .captures(entry)
        .or_else(|| bracket_member.captures(entry))
    {
        let object = captures
            .name("object")
            .map(|value| value.as_str())
            .ok_or_else(|| "YouTube transform helper member object is missing".to_owned())?;
        let method = captures
            .name("method")
            .map(|value| value.as_str())
            .ok_or_else(|| "YouTube transform helper member method is missing".to_owned())?;
        return classify_helper_operation(script, object, method, amount);
    }

    if Regex::new(r#"^[A-Za-z_$][A-Za-z0-9_$]*$"#)
        .map_err(|error| error.to_string())?
        .is_match(entry)
    {
        return classify_named_helper_operation(script, entry, amount);
    }

    Err(format!(
        "YouTube transform helper {array}[{index}] is not a supported function alias"
    ))
}

fn classify_named_helper_operation(
    script: &str,
    name: &str,
    amount: usize,
) -> Result<TransformOperation, String> {
    let patterns = [
        Regex::new(&format!(
            r#"{}\s*=\s*function\([^)]*\)\s*\{{"#,
            regex::escape(name)
        )),
        Regex::new(&format!(
            r#"function\s+{}\([^)]*\)\s*\{{"#,
            regex::escape(name)
        )),
        Regex::new(&format!(
            r#"{}\s*=\s*\([^)]*\)\s*=>\s*\{{"#,
            regex::escape(name)
        )),
        Regex::new(&format!(
            r#"{}\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\s*=>\s*\{{"#,
            regex::escape(name)
        )),
    ];

    for pattern in patterns {
        let pattern = pattern.map_err(|error| error.to_string())?;
        if let Some(function_match) = pattern.find(script) {
            let brace = function_match.end().saturating_sub(1);
            let body = balanced_block(script, brace, b'{', b'}')
                .ok_or_else(|| format!("YouTube transform helper {name} is malformed"))?;
            return classify_operation_body(body, amount)
                .ok_or_else(|| format!("unsupported YouTube transform helper {name}"));
        }
    }

    Err(format!("YouTube transform helper {name} was not found"))
}

fn operation_amount(body: &str, fallback: usize) -> usize {
    if fallback != 0 {
        return fallback;
    }
    for pattern in [
        r#"\.splice\(\s*0\s*,\s*(\d+)"#,
        r#"\.slice\(\s*(\d+)"#,
        r#"\.splice\(\s*-\s*(\d+)"#,
        r#"\[\s*(\d+)\s*%"#,
    ] {
        if let Ok(regex) = Regex::new(pattern) {
            if let Some(amount) = regex
                .captures(body)
                .and_then(|captures| captures.get(1))
                .and_then(|value| value.as_str().parse::<usize>().ok())
            {
                return amount;
            }
        }
    }
    fallback
}

fn classify_operation_body(body: &str, amount: usize) -> Option<TransformOperation> {
    let amount = operation_amount(body, amount);

    let splice_swap = Regex::new(
        r#"(?P<target>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*0\s*\]\s*=\s*(?P<source>[A-Za-z_$][A-Za-z0-9_$]*)\.splice\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*%\s*(?P<len>[A-Za-z_$][A-Za-z0-9_$]*)\.length\s*,\s*1\s*,\s*(?P<insert>[A-Za-z_$][A-Za-z0-9_$]*)\s*\[\s*0\s*\]\s*\)\s*\[\s*0\s*\]"#,
    )
    .ok();
    if let Some(captures) = splice_swap.as_ref().and_then(|pattern| pattern.captures(body)) {
        let target = captures.name("target").map(|value| value.as_str());
        let source = captures.name("source").map(|value| value.as_str());
        let len = captures.name("len").map(|value| value.as_str());
        let insert = captures.name("insert").map(|value| value.as_str());
        if target.is_some() && target == source && target == len && target == insert {
            return Some(TransformOperation::Swap(amount));
        }
    }

    let has_reverse = body.contains(".reverse(");
    let has_splice = body.contains(".splice(");
    let has_slice = body.contains(".slice(");
    let has_push = body.contains(".push(") || body.contains(".push.apply(");
    let has_unshift = body.contains(".unshift(") || body.contains(".unshift.apply(");
    let has_shift = body.contains(".shift()");
    let has_pop = body.contains(".pop()");

    if has_reverse {
        if has_splice || has_slice || has_push || has_unshift || has_shift || has_pop {
            return None;
        }
        return Some(TransformOperation::Reverse);
    }

    if body.contains(".push.apply(") && body.contains(".splice(0,") {
        if has_unshift || has_reverse || has_slice || has_pop {
            return None;
        }
        return Some(TransformOperation::RotateLeft(amount));
    }
    if body.contains(".push(...") && body.contains(".splice(0,") {
        if has_unshift || has_reverse || has_slice || has_pop {
            return None;
        }
        return Some(TransformOperation::RotateLeft(amount));
    }
    if body.contains(".unshift.apply(") && body.contains(".splice(-") {
        if has_push || has_reverse || has_slice || has_shift {
            return None;
        }
        return Some(TransformOperation::RotateRight(amount));
    }
    if body.contains(".unshift(...") && body.contains(".splice(-") {
        if has_push || has_reverse || has_slice || has_shift {
            return None;
        }
        return Some(TransformOperation::RotateRight(amount));
    }
    if has_push && has_shift {
        if has_splice || has_unshift || has_reverse || has_slice || has_pop {
            return None;
        }
        return Some(TransformOperation::RotateLeft(1));
    }
    if has_push && body.contains(".splice(0,1)") {
        if has_unshift || has_reverse || has_slice || has_pop {
            return None;
        }
        return Some(TransformOperation::RotateLeft(1));
    }
    if has_unshift && has_pop {
        if has_splice || has_push || has_reverse || has_slice || has_shift {
            return None;
        }
        return Some(TransformOperation::RotateRight(1));
    }
    if has_unshift && body.contains(".splice(-1,1)") {
        if has_push || has_reverse || has_slice || has_shift {
            return None;
        }
        return Some(TransformOperation::RotateRight(1));
    }

    if body.contains("[0]") && body.contains(".length") && body.contains('%') {
        if has_reverse || has_splice || has_slice || has_push || has_unshift || has_shift || has_pop {
            return None;
        }
        return Some(TransformOperation::Swap(amount));
    }

    let splice_drop = Regex::new(
        r#"\.splice\(\s*0\s*,\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)\s*\)"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(body));
    if splice_drop {
        if has_reverse || has_slice || has_push || has_unshift || has_shift || has_pop {
            return None;
        }
        return Some(TransformOperation::Drop(amount));
    }

    let returned_slice = Regex::new(
        r#"return\s+[A-Za-z_$][A-Za-z0-9_$]*\.slice\(\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)\s*\)"#,
    )
    .ok()
    .is_some_and(|pattern| pattern.is_match(body));
    if returned_slice {
        if has_reverse || has_splice || has_push || has_unshift || has_shift || has_pop {
            return None;
        }
        return Some(TransformOperation::Drop(amount));
    }

    None
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
        r#"(?:"|')?{}(?:"|')?\s*(?::\s*function\([^)]*\)\s*|:\s*\([^)]*\)\s*=>\s*|:\s*[A-Za-z_$][A-Za-z0-9_$]*\s*=>\s*|\([^)]*\)\s*)\{{"#,
        regex::escape(method)
    ))
    .map_err(|error| error.to_string())?;
    let method_match = method_pattern
        .find(object_body)
        .ok_or_else(|| format!("YouTube signature helper method {object}.{method} was not found"))?;
    let relative_brace = method_match.end().saturating_sub(1);
    let method_body = balanced_block(object_body, relative_brace, b'{', b'}')
        .ok_or_else(|| format!("YouTube signature helper method {object}.{method} is malformed"))?;

    classify_operation_body(method_body, amount).ok_or_else(|| {
        format!("unsupported YouTube transform helper method {object}.{method}")
    })
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
    fn signature_parser_supports_top_level_comma_pipeline() {
        let player = r#"
var HH={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)}};
SG=function(a){a=a.split(""),HH.Rv(a),HH.Sp(a,2);return a.join("")};
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("comma signature pipeline"),
            "dcba"
        );
    }

    #[test]
    fn signature_parser_skips_n_transform_hidden_behind_array_alias() {
        let player = r#"
NT=function(a){a=a.split("");a.reverse();return a.join("")};
var NX=[NT];
SG=function(a){a=a.split("");a=a.slice(2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NX[0](x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("signature transform"),
            "cdef"
        );
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("n transform"),
            "fedcba"
        );
    }

    #[test]
    fn signature_parser_supports_arrow_transform() {
        let player = r#"SG=(a)=>{a=a.split("");a.reverse();return a.join("")};"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("arrow signature"),
            "fedcba"
        );
    }

    #[test]
    fn signature_parser_does_not_select_verified_n_transform() {
        let player = r#"
NT=function(a){a=a.split("");a.reverse();return a.join("")};
SG=function(a){a=a.split("");a=a.slice(2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .decipher_signature(player, "abcdef")
                .expect("signature transform"),
            "cdef"
        );
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_rejects_oversized_player_script() {
        let player = "x".repeat(PLAYER_SCRIPT_MAX_BYTES + 1);
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(&player, "abc")
            .is_err());
    }

    #[test]
    fn resolves_named_n_transform_from_n_parameter_call_site() {
        let player = r#"
NT=function(a){a=a.split("");a.reverse();a=a.slice(1);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("n transform"),
            "edcba"
        );
    }

    #[test]
    fn resolves_indexed_n_transform_and_rotate_left() {
        let player = r#"
var NX=[function(a){a=a.split("");a.push.apply(a,a.splice(0,2));return a.join("")}];
function apply(p){var x=p.get("n");x&&(x=NX[0](x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("indexed n transform"),
            "cdefab"
        );
    }

    #[test]
    fn n_transform_resolves_nn_dispatch_indexed_target() {
        let player = r#"
var NX=[function(a){a=a.split("");a.reverse();return a.join("")}];
function apply(p){var b="nn"[+p.D],c=p.j[b]||null;c&&(c=NX[0](c),p.set(b,c))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("nn dispatch n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_supports_arrow_helper_arrays() {
        let player = r#"
var HH=[a=>{a.reverse()}];
NT=function(a){a=a.split("");HH[0](a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("arrow helper-array n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_supports_arrow_function_and_concise_helper() {
        let player = r#"
var HH={Rv(a){a.reverse()}};
NT=(a)=>{a=a.split("");HH.Rv(a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("arrow n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_tracks_local_split_variable_and_safe_guard() {
        let player = r#"
NT=function(a){if(typeof Q==="undefined")return a;var b=a.split("");b.reverse();return b.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("local-variable n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_supports_bracket_notation_helpers() {
        let player = r#"
var HH={"Rv":function(a){a.reverse()}};
NT=function(a){a=a.split("");HH["Rv"](a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("bracket helper n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_supports_indexed_helper_operations() {
        let player = r#"
var HH=[
function(a){a.reverse()},
function(a,b){a.splice(0,b)}
];
NT=function(a){a=a.split("");HH[0](a);HH[1](a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("helper n transform"),
            "dcba"
        );
    }

    #[test]
    fn n_transform_supports_top_level_comma_pipeline() {
        let player = r#"
var HH={Rv:function(a){a.reverse()},Sp:function(a,b){a.splice(0,b)}};
NT=function(a){a=a.split(""),HH.Rv(a),HH.Sp(a,1);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("comma n-transform pipeline"),
            "edcba"
        );
    }

    #[test]
    fn n_transform_supports_object_member_target_alias() {
        let player = r#"
var OPS={Nt:function(a){a=a.split("");a.reverse();return a.join("")}};
var NX=[OPS.Nt];
function apply(p){var x=p.get("n");x&&(x=NX[0](x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("object-member n transform"),
            "fedcba"
        );
    }

    #[test]
    fn n_transform_supports_member_aliases_inside_helper_arrays() {
        let player = r#"
var OPS={
Rv:function(a){a.reverse()},
Sp:function(a,b){a.splice(0,b)}
};
var HH=[OPS.Rv,OPS["Sp"]];
NT=function(a){a=a.split("");HH[0](a);HH[1](a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("member-alias helper array"),
            "dcba"
        );
    }

    #[test]
    fn n_transform_supports_named_function_aliases_inside_helper_arrays() {
        let player = r#"
RV=function(a){a.reverse()};
function SP(a,b){a.splice(0,b)}
var HH=[RV,SP];
NT=function(a){a=a.split("");HH[0](a);HH[1](a,1);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("named helper aliases"),
            "edcba"
        );
    }

    #[test]
    fn n_transform_supports_splice_swap_helper_family() {
        let player = r#"
var HH={Sw:function(a,b){a[0]=a.splice(b%a.length,1,a[0])[0]}};
NT=function(a){a=a.split("");HH.Sw(a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert_eq!(
            solver
                .transform_throttling_parameter(player, "abcdef")
                .expect("splice swap"),
            "cbadef"
        );
    }

    #[test]
    fn n_transform_rejects_compound_return_instead_of_dropping_hidden_work() {
        let player = r#"
NT=function(a){a=a.split("");return a.reverse(),a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(player, "abcdef")
            .is_err());
    }

    #[test]
    fn n_transform_rejects_member_alias_that_is_not_a_transform() {
        let player = r#"
var OPS={Bad:function(a){a.push("x")}};
var HH=[OPS.Bad];
NT=function(a){a=a.split("");HH[0](a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(player, "abcdef")
            .is_err());
    }

    #[test]
    fn n_transform_fails_closed_without_a_verified_call_site() {
        let player = r#"NT=function(a){a=a.split("");a.reverse();return a.join("")};"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(player, "abc")
            .is_err());
    }

    #[test]
    fn n_transform_rejects_compound_helper_instead_of_partial_execution() {
        let player = r#"
var HH={XX:function(a,b){a.reverse();a.splice(0,b)}};
NT=function(a){a=a.split("");HH.XX(a,2);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(player, "abcdef")
            .is_err());
    }

    #[test]
    fn n_transform_rejects_unknown_helpers() {
        let player = r#"
var HH={XX:function(a){a.push("x")}};
NT=function(a){a=a.split("");HH.XX(a);return a.join("")};
function apply(p){var x=p.get("n");x&&(x=NT(x),p.set("n",x))}
"#;
        let solver = YouTubePlayerScriptSolver;
        assert!(solver
            .transform_throttling_parameter(player, "abc")
            .is_err());
    }
}
