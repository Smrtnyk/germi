//! Fiddler Classic `AutoResponder` (`.farx`) import.
//!
//! Classic FARX files are UTF-8 XML documents with an `AutoResponder` root and
//! ordered `ResponseRule` elements. Fiddler Everywhere reuses the extension for
//! a different, encoded rules language (`RulesVersion="2"`); Germi rejects that
//! dialect explicitly instead of importing inert or behaviorally different
//! rules.

use std::collections::HashMap;

use anyhow::{Context, Result};
use quick_xml::encoding::Decoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::http_semantics::valid_header;
use crate::rules::{respond_action_from_response, Action, MatchKind, Matcher, Rule, Scenario};
use crate::rules_export::RulesExport;

const FARX_SCENARIO_NAME: &str = "Fiddler AutoResponder";

pub(crate) fn looks_like_xml(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    bytes
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        == Some(b'<')
}

pub(crate) fn parse_farx(bytes: &[u8]) -> Result<RulesExport> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);

    let mut saw_root = false;
    let mut root_depth = 0usize;
    let mut root_closed = false;
    let mut state_enabled = true;
    let mut use_latency = false;
    let mut rules = Vec::new();

    loop {
        let event = reader.read_event().context("could not parse FARX XML")?;
        match event {
            Event::Start(element) => {
                if root_closed {
                    anyhow::bail!("not a FARX file: XML contains content after AutoResponder");
                }
                if saw_root {
                    root_depth += 1;
                    match element.name().as_ref() {
                        b"State" => parse_state(
                            &element,
                            reader.decoder(),
                            &mut state_enabled,
                            &mut use_latency,
                        )?,
                        b"ResponseRule" => push_response_rule(
                            &element,
                            reader.decoder(),
                            &mut rules,
                            state_enabled,
                            use_latency,
                        )?,
                        _ => {}
                    }
                } else {
                    validate_root(&element, reader.decoder())?;
                    saw_root = true;
                    root_depth = 1;
                }
            }
            Event::Empty(element) => {
                if root_closed {
                    anyhow::bail!("not a FARX file: XML contains content after AutoResponder");
                }
                if saw_root {
                    match element.name().as_ref() {
                        b"State" => parse_state(
                            &element,
                            reader.decoder(),
                            &mut state_enabled,
                            &mut use_latency,
                        )?,
                        b"ResponseRule" => push_response_rule(
                            &element,
                            reader.decoder(),
                            &mut rules,
                            state_enabled,
                            use_latency,
                        )?,
                        _ => {}
                    }
                } else {
                    validate_root(&element, reader.decoder())?;
                    saw_root = true;
                    root_closed = true;
                }
            }
            Event::End(_) if saw_root => {
                root_depth = root_depth
                    .checked_sub(1)
                    .ok_or_else(|| anyhow::anyhow!("not a FARX file: malformed XML nesting"))?;
                root_closed = root_depth == 0;
            }
            Event::Text(text) if !text.iter().all(|byte: &u8| byte.is_ascii_whitespace()) => {
                if root_closed {
                    anyhow::bail!("not a FARX file: XML contains content after AutoResponder");
                }
                if !saw_root {
                    anyhow::bail!("not a FARX file: expected an AutoResponder root element");
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }

    if !saw_root {
        anyhow::bail!("not a FARX file: missing AutoResponder root element");
    }
    if !root_closed {
        anyhow::bail!("not a FARX file: unclosed AutoResponder root element");
    }
    if rules.is_empty() {
        anyhow::bail!("FARX file contains no AutoResponder rules");
    }

    Ok(RulesExport::new(vec![Scenario {
        id: "farx-import".to_string(),
        name: FARX_SCENARIO_NAME.to_string(),
        rules,
    }]))
}

fn validate_root(element: &BytesStart<'_>, decoder: Decoder) -> Result<()> {
    if element.name().as_ref() != b"AutoResponder" {
        anyhow::bail!("not a FARX file: expected an AutoResponder root element");
    }
    let attrs = attributes(element, decoder)?;
    if let Some(version) = attrs.get("RulesVersion") {
        anyhow::bail!(
            "Fiddler Everywhere FARX RulesVersion {version} is not supported; import a Fiddler Classic AutoResponder FARX export"
        );
    }
    Ok(())
}

fn parse_state(
    element: &BytesStart<'_>,
    decoder: Decoder,
    state_enabled: &mut bool,
    use_latency: &mut bool,
) -> Result<()> {
    let attrs = attributes(element, decoder)?;
    if let Some(value) = attrs.get("Enabled") {
        *state_enabled = parse_bool(value, "State Enabled")?;
    }
    if let Some(value) = attrs.get("UseLatency") {
        *use_latency = parse_bool(value, "State UseLatency")?;
    }
    if attrs
        .get("Fallthrough")
        .map(|value| parse_bool(value, "State Fallthrough"))
        .transpose()?
        == Some(false)
    {
        anyhow::bail!(
            "FARX State Fallthrough=false is not supported; Germi cannot safely reproduce Fiddler's unmatched-request behavior"
        );
    }
    Ok(())
}

fn push_response_rule(
    element: &BytesStart<'_>,
    decoder: Decoder,
    rules: &mut Vec<Rule>,
    state_enabled: bool,
    use_latency: bool,
) -> Result<()> {
    let number = rules.len() + 1;
    let rule = parse_response_rule(element, decoder, number, state_enabled, use_latency)
        .map_err(|error| anyhow::anyhow!("could not import FARX rule {number}: {error:#}"))?;
    rules.push(rule);
    Ok(())
}

fn attributes(element: &BytesStart<'_>, decoder: Decoder) -> Result<HashMap<String, String>> {
    let mut values = HashMap::new();
    for attribute in element.attributes().with_checks(true) {
        let attribute = attribute.context("invalid FARX XML attribute")?;
        let name = std::str::from_utf8(attribute.key.as_ref())
            .context("FARX attribute name is not UTF-8")?
            .to_string();
        let value = attribute
            .decode_and_unescape_value(decoder)
            .context("invalid escaped value in FARX XML attribute")?
            .into_owned();
        values.insert(name, value);
    }
    Ok(values)
}

fn parse_response_rule(
    element: &BytesStart<'_>,
    decoder: Decoder,
    number: usize,
    state_enabled: bool,
    use_latency: bool,
) -> Result<Rule> {
    let attrs = attributes(element, decoder)?;
    let match_text = required(&attrs, "Match")?;
    let action_text = required(&attrs, "Action")?;

    if match_text.trim_start().starts_with('{') || action_text.trim_start().starts_with('[') {
        anyhow::bail!(
            "encoded Fiddler Everywhere rules are not supported; import a Fiddler Classic AutoResponder FARX export"
        );
    }

    if use_latency
        && attrs
            .get("Latency")
            .is_some_and(|value| value.trim() != "0" && !value.trim().is_empty())
    {
        anyhow::bail!(
            "rule latency is not supported by Germi's autoresponder; remove the FARX rule latency before importing"
        );
    }

    let enabled = state_enabled
        && attrs
            .get("Enabled")
            .map(|value| parse_bool(value, "Enabled"))
            .transpose()?
            .unwrap_or(true);
    let fire_limit = attrs
        .get("MaxMatchCount")
        .map(|value| {
            value
                .trim()
                .parse::<u32>()
                .with_context(|| format!("invalid MaxMatchCount value '{value}'"))
        })
        .transpose()?
        .filter(|limit| *limit > 0);

    let matcher = parse_matcher(match_text)?;
    let action = if attrs.contains_key("Headers") || attrs.contains_key("Body") {
        parse_embedded_response(attrs.get("Headers"), attrs.get("Body"))?
    } else {
        parse_action(action_text)?
    };
    if matcher.url_match == MatchKind::Regex {
        if !matches!(action, Action::MapRemote { .. }) && has_replacement_reference(action_text) {
            anyhow::bail!(
                "Fiddler replacement references in this action cannot be represented by Germi"
            );
        }
        if let Action::MapRemote { url } = &action {
            let (plain, named) = capture_kinds(&matcher.url);
            if plain && named && has_numeric_replacement_reference(url) {
                anyhow::bail!(
                    "mixed named and numbered .NET regex captures would change $n replacement numbering in Germi"
                );
            }
        }
    }

    Ok(Rule {
        id: format!("farx-rule-{number}"),
        enabled,
        fire_limit,
        repeat: false,
        matcher,
        action,
    })
}

fn required<'a>(attrs: &'a HashMap<String, String>, name: &str) -> Result<&'a str> {
    attrs
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("ResponseRule is missing its {name} attribute"))
}

fn parse_bool(value: &str, name: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => anyhow::bail!("invalid {name} boolean value '{value}'"),
    }
}

fn parse_matcher(match_text: &str) -> Result<Matcher> {
    let mut expression = match_text.trim();
    let mut method = None;

    if let Some(after_method) = strip_prefix_ignore_ascii_case(expression, "METHOD:") {
        let method_end = after_method
            .find(char::is_whitespace)
            .unwrap_or(after_method.len());
        let parsed_method = &after_method[..method_end];
        if parsed_method.is_empty() {
            anyhow::bail!("METHOD matcher is missing its HTTP method");
        }
        method = Some(parsed_method.to_ascii_uppercase());
        expression = after_method[method_end..].trim_start();
    }

    if strip_prefix_ignore_ascii_case(expression, "NOT:").is_some() {
        anyhow::bail!("Fiddler NOT matchers are not supported by Germi");
    }
    for unsupported in ["HEADER:", "FLAG:", "URLANDBODY:", "URLWITHBODY:"] {
        if strip_prefix_ignore_ascii_case(expression, unsupported).is_some() {
            anyhow::bail!("Fiddler {unsupported} matchers are not supported by Germi");
        }
    }

    let (url, url_match) = if let Some(exact) = strip_prefix_ignore_ascii_case(expression, "EXACT:")
    {
        (exact.to_string(), MatchKind::Exact)
    } else if let Some(pattern) = strip_prefix_ignore_ascii_case(expression, "REGEX:") {
        let pattern = normalize_dotnet_regex(pattern)?;
        regex::Regex::new(&pattern).with_context(|| {
            format!("Fiddler regex cannot be represented by Germi: '{pattern}'")
        })?;
        (pattern, MatchKind::Regex)
    } else if expression.is_empty() {
        (String::new(), MatchKind::Contains)
    } else {
        // Fiddler Classic literal matching is case-insensitive. Germi's plain
        // Contains matcher is case-sensitive, so use an escaped regex to retain
        // the source rule's behavior.
        (
            format!("(?i:{})", regex::escape(expression)),
            MatchKind::Regex,
        )
    };

    Ok(Matcher {
        method,
        url,
        url_match,
    })
}

fn normalize_dotnet_regex(pattern: &str) -> Result<String> {
    let mut normalized = pattern.to_string();

    // Fiddler's recommended `(?insx)` prefix includes .NET's explicit-capture
    // `n` flag, which Rust regex does not understand. Convert ordinary capture
    // groups to non-capturing groups before dropping `n`, preserving named
    // captures and their numbering for Map Remote substitutions.
    if let Some(close) = normalized
        .strip_prefix("(?")
        .and_then(|rest| rest.find(')'))
    {
        let close = close + 2;
        let flags = &normalized[2..close];
        if flags
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
            && flags.bytes().any(|byte| matches!(byte, b'n' | b'N'))
        {
            let (enabled_flags, disabled_flags) =
                flags.split_once('-').map_or((flags, ""), |parts| parts);
            let enabled_n = enabled_flags
                .bytes()
                .any(|byte| matches!(byte, b'n' | b'N'));
            let disabled_n = disabled_flags
                .bytes()
                .any(|byte| matches!(byte, b'n' | b'N'));
            if enabled_n && disabled_n {
                anyhow::bail!("conflicting .NET explicit-capture flags in FARX regex");
            }
            let explicit_capture = enabled_flags
                .bytes()
                .any(|byte| matches!(byte, b'n' | b'N'));
            let enabled_flags: String = enabled_flags
                .chars()
                .filter(|flag| !matches!(flag, 'n' | 'N'))
                .collect();
            let disabled_flags: String = disabled_flags
                .chars()
                .filter(|flag| !matches!(flag, 'n' | 'N'))
                .collect();
            let flags = match (enabled_flags.is_empty(), disabled_flags.is_empty()) {
                (true, true) => String::new(),
                (false, true) => enabled_flags,
                (true, false) => format!("-{disabled_flags}"),
                (false, false) => format!("{enabled_flags}-{disabled_flags}"),
            };
            let mut remainder = normalized[close + 1..].to_string();
            if explicit_capture {
                remainder = make_plain_groups_noncapturing(&remainder);
            }
            normalized = if flags.is_empty() || flags == "-" {
                remainder
            } else {
                format!("(?{flags}){remainder}")
            };
        }
    }

    normalized = convert_dotnet_named_captures(&normalized)?;
    Ok(normalized)
}

fn make_plain_groups_noncapturing(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();
    let mut in_class = false;
    while let Some(character) = chars.next() {
        match character {
            '\\' => {
                out.push(character);
                if let Some(escaped) = chars.next() {
                    out.push(escaped);
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(character);
            }
            ']' if in_class => {
                in_class = false;
                out.push(character);
            }
            '(' if !in_class && chars.peek() != Some(&'?') => out.push_str("(?:"),
            _ => out.push(character),
        }
    }
    out
}

fn capture_kinds(pattern: &str) -> (bool, bool) {
    let bytes = pattern.as_bytes();
    let mut plain = false;
    let mut named = false;
    let mut escaped = false;
    let mut in_class = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
        } else {
            match byte {
                b'\\' => escaped = true,
                b'[' if !in_class => in_class = true,
                b']' if in_class => in_class = false,
                b'(' if !in_class && bytes.get(index + 1) != Some(&b'?') => plain = true,
                b'(' if !in_class && bytes.get(index + 1..index + 4) == Some(b"?P<") => {
                    named = true;
                }
                _ => {}
            }
        }
        index += 1;
    }
    (plain, named)
}

fn convert_dotnet_named_captures(pattern: &str) -> Result<String> {
    let mut out = String::with_capacity(pattern.len());
    let mut rest = pattern;
    while let Some(start) = rest.find("(?'") {
        out.push_str(&rest[..start]);
        let name_start = start + 3;
        let name_end = rest[name_start..]
            .find('\'')
            .map(|offset| name_start + offset)
            .ok_or_else(|| anyhow::anyhow!("unterminated .NET named capture in FARX regex"))?;
        let name = &rest[name_start..name_end];
        if name.is_empty() {
            anyhow::bail!("empty .NET named capture in FARX regex");
        }
        out.push_str("(?P<");
        out.push_str(name);
        out.push('>');
        rest = &rest[name_end + 1..];
    }
    out.push_str(rest);

    // .NET also accepts `(?<name>...)`. Do not rewrite lookbehind forms,
    // whose first character after `<` is `=` or `!`.
    let mut converted = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(start) = rest.find("(?<") {
        converted.push_str(&rest[..start]);
        let name_start = start + 3;
        let Some(first) = rest[name_start..].chars().next() else {
            break;
        };
        if !(first.is_ascii_alphabetic() || first == '_') {
            converted.push_str("(?<");
            rest = &rest[name_start..];
            continue;
        }
        let name_end = rest[name_start..]
            .find('>')
            .map(|offset| name_start + offset)
            .ok_or_else(|| anyhow::anyhow!("unterminated .NET named capture in FARX regex"))?;
        converted.push_str("(?P<");
        converted.push_str(&rest[name_start..name_end]);
        converted.push('>');
        rest = &rest[name_end + 1..];
    }
    converted.push_str(rest);
    Ok(converted)
}

fn parse_action(action_text: &str) -> Result<Action> {
    let action_text = action_text.trim();
    if let Some(target) = strip_prefix_ignore_ascii_case(action_text, "*REDIR:") {
        let target = target.trim();
        if target.is_empty() {
            anyhow::bail!("Fiddler redirect action is missing its target URL");
        }
        return Ok(Action::Respond {
            status: 307,
            headers: vec![("Location".to_string(), target.to_string())],
            body: String::new(),
            body_base64: None,
            content_type: None,
            content_encoding: None,
        });
    }
    if let Some(header) = strip_prefix_ignore_ascii_case(action_text, "*HEADER:") {
        let (name, value) = header
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("Fiddler header action must use Name=Value"))?;
        if !valid_header(name.trim(), value.trim()) {
            anyhow::bail!("Fiddler header action contains an invalid HTTP header");
        }
        return Ok(Action::SetRequestHeader {
            name: name.trim().to_string(),
            value: value.trim().to_string(),
        });
    }
    if is_session_response_reference(action_text) {
        anyhow::bail!(
            "Fiddler stored-session action '{action_text}' has no embedded Headers/Body payload"
        );
    }
    if let Some(status) = canned_status(action_text) {
        return Ok(Action::Respond {
            status,
            headers: Vec::new(),
            body: String::new(),
            body_base64: None,
            content_type: None,
            content_encoding: None,
        });
    }
    if action_text.starts_with('*') {
        anyhow::bail!("Fiddler action '{action_text}' is not supported by Germi's autoresponder");
    }
    if action_text
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
        || action_text
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return Ok(Action::MapRemote {
            url: action_text.to_string(),
        });
    }
    if action_text.is_empty() {
        anyhow::bail!("Fiddler rule action is empty");
    }
    Ok(Action::MapLocal {
        path: action_text.to_string(),
        status: 200,
    })
}

fn canned_status(action: &str) -> Option<u16> {
    let bytes = action.as_bytes();
    if bytes.len() < 5 || bytes[0] != b'*' || bytes[4] != b'-' {
        return None;
    }
    let status = action[1..4].parse::<u16>().ok()?;
    (100..=599).contains(&status).then_some(status)
}

fn is_session_response_reference(action: &str) -> bool {
    canned_status(action).is_some()
        && action[5..]
            .trim_start()
            .to_ascii_uppercase()
            .starts_with("SESSION")
}

fn has_replacement_reference(value: &str) -> bool {
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '$' {
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
            }
            Some('{' | '0'..='9' | 'a'..='z' | 'A'..='Z' | '_') => return true,
            _ => {}
        }
    }
    false
}

fn has_numeric_replacement_reference(value: &str) -> bool {
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '$' {
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
            }
            Some('0'..='9') => return true,
            Some('{') => {
                let mut braced = chars.clone();
                braced.next();
                if braced.next().is_some_and(|next| next.is_ascii_digit()) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn parse_embedded_response(headers: Option<&String>, body: Option<&String>) -> Result<Action> {
    let headers = match headers {
        Some(encoded) => crate::body::base64_lenient(encoded)
            .ok_or_else(|| anyhow::anyhow!("FARX response Headers is not valid base64"))?,
        None => b"HTTP/1.1 200 OK\r\n\r\n".to_vec(),
    };
    let body = match body {
        Some(encoded) => crate::body::base64_lenient(encoded)
            .ok_or_else(|| anyhow::anyhow!("FARX response Body is not valid base64"))?,
        None => Vec::new(),
    };
    let mut raw = Vec::with_capacity(headers.len() + body.len());
    raw.extend_from_slice(&headers);
    raw.extend_from_slice(&body);
    let response = crate::import::parse_response(&raw)
        .context("FARX embedded response has an invalid HTTP response head")?;
    Ok(respond_action_from_response(&response))
}

fn strip_prefix_ignore_ascii_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let candidate = value.get(..prefix.len())?;
    candidate
        .eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_classic_farx_matchers_and_actions_in_order() {
        let xml = br#"<?xml version="1.0" encoding="utf-8"?>
          <AutoResponder FiddlerVersion="5.0.20245.10105">
            <State Enabled="true" Fallthrough="true" UseLatency="false">
              <ResponseRule Match="METHOD:GET EXACT:https://api.example.test/users?x=1&amp;y=2"
                Action="*redir: https://login.example.test/next " Enabled="true" />
              <ResponseRule Match="regex:(?insx)^https://api.example.test/(?'id'.*)$"
                Action="https://mirror.example.test/${id}" Enabled="false" MaxMatchCount="3" />
              <ResponseRule Match="Images/Logo.svg" Action="C:\mocks\logo.svg" Enabled="1" />
              <ResponseRule Match="METHOD:POST upload" Action="*header:X-Imported=yes" />
            </State>
          </AutoResponder>"#;
        let bytes = [&[0xef, 0xbb, 0xbf][..], xml].concat();

        let export = parse_farx(&bytes).expect("Classic FARX imports");
        assert_eq!(export.scenarios.len(), 1);
        let scenario = &export.scenarios[0];
        assert_eq!(scenario.name, FARX_SCENARIO_NAME);
        assert_eq!(scenario.rules.len(), 4);

        assert_eq!(scenario.rules[0].matcher.method.as_deref(), Some("GET"));
        assert_eq!(scenario.rules[0].matcher.url_match, MatchKind::Exact);
        assert_eq!(
            scenario.rules[0].matcher.url,
            "https://api.example.test/users?x=1&y=2"
        );
        assert!(matches!(
            &scenario.rules[0].action,
            Action::Respond { status: 307, headers, .. }
                if headers == &[("Location".to_string(), "https://login.example.test/next".to_string())]
        ));

        assert_eq!(
            scenario.rules[1].matcher.url,
            "(?isx)^https://api.example.test/(?P<id>.*)$"
        );
        assert!(!scenario.rules[1].enabled);
        assert_eq!(scenario.rules[1].fire_limit, Some(3));
        assert!(matches!(
            &scenario.rules[1].action,
            Action::MapRemote { url } if url == "https://mirror.example.test/${id}"
        ));

        assert_eq!(scenario.rules[2].matcher.url, "(?i:Images/Logo\\.svg)");
        assert!(matches!(
            &scenario.rules[2].action,
            Action::MapLocal { path, status: 200 } if path == r"C:\mocks\logo.svg"
        ));
        assert_eq!(scenario.rules[3].matcher.method.as_deref(), Some("POST"));
        assert!(matches!(
            &scenario.rules[3].action,
            Action::SetRequestHeader { name, value } if name == "X-Imported" && value == "yes"
        ));
    }

    #[test]
    fn explicit_capture_flag_preserves_dotnet_capture_numbering() {
        let normalized = normalize_dotnet_regex(r"(?insx)^(plain)(?'named'value)\(literal\)[()]$")
            .expect("regex normalizes");
        assert_eq!(
            normalized,
            r"(?isx)^(?:plain)(?P<named>value)\(literal\)[()]$"
        );
        let captures = regex::Regex::new(&normalized)
            .expect("normalized regex compiles")
            .captures("plainvalue(literal)(")
            .expect("normalized regex matches");
        assert_eq!(
            captures.get(1).map(|capture| capture.as_str()),
            Some("value")
        );
        assert_eq!(
            captures.name("named").map(|capture| capture.as_str()),
            Some("value")
        );

        assert_eq!(
            normalize_dotnet_regex(r"(?i-n)^(plain)$").expect("disabled n normalizes"),
            r"(?i)^(plain)$"
        );
    }

    #[test]
    fn disabled_farx_state_keeps_every_imported_rule_disabled() {
        let farx = br#"<AutoResponder><State Enabled="false">
          <ResponseRule Match="one" Action="*204-NOCONTENT" Enabled="true" />
          <ResponseRule Match="two" Action="*404-NOTFOUND" />
          </State></AutoResponder>"#;

        let export = parse_farx(farx).expect("disabled State imports");
        assert!(export.scenarios[0].rules.iter().all(|rule| !rule.enabled));
    }

    #[test]
    fn inactive_farx_latency_is_ignored_but_active_latency_is_rejected() {
        let inactive = br#"<AutoResponder><State UseLatency="false">
          <ResponseRule Match="one" Action="*200-OK" Latency="500" />
          </State></AutoResponder>"#;
        parse_farx(inactive).expect("globally disabled latency changes no behavior");

        let active = br#"<AutoResponder><State UseLatency="true">
          <ResponseRule Match="one" Action="*200-OK" Latency="500" />
          </State></AutoResponder>"#;
        let error = parse_farx(active).unwrap_err().to_string();
        assert!(error.contains("rule latency is not supported"));

        let no_fallthrough = br#"<AutoResponder><State Fallthrough="false">
          <ResponseRule Match="one" Action="*200-OK" />
          </State></AutoResponder>"#;
        let error = parse_farx(no_fallthrough).unwrap_err().to_string();
        assert!(error.contains("State Fallthrough=false is not supported"));
    }

    #[test]
    fn imports_embedded_response_headers_text_and_binary_body() {
        use base64::Engine as _;

        let headers = base64::engine::general_purpose::STANDARD.encode(
            b"HTTP/1.1 201 Created\r\nContent-Type: application/octet-stream\r\nX-Keep: yes\r\nContent-Length: 3\r\n\r\n",
        );
        let body = base64::engine::general_purpose::STANDARD.encode([0xff, 0x00, 0x7f]);
        let farx = format!(
            r#"<AutoResponder><State><ResponseRule Match="EXACT:https://api.test/bin" Action="*201-SESSION_1" Enabled="true" Headers="{headers}" Body="{body}" /></State></AutoResponder>"#
        );

        let export = parse_farx(farx.as_bytes()).expect("embedded response imports");
        assert!(matches!(
            &export.scenarios[0].rules[0].action,
            Action::Respond {
                status: 201,
                headers,
                body_base64: Some(encoded),
                content_type: Some(content_type),
                ..
            } if headers == &[("X-Keep".to_string(), "yes".to_string())]
                && crate::body::base64_lenient(encoded) == Some(vec![0xff, 0x00, 0x7f])
                && content_type == "application/octet-stream"
        ));
    }

    #[test]
    fn imports_public_fiddler_embedded_response_shape() {
        // Representative Headers/Body values from a public Fiddler 5.0.1 FARX
        // export. FARX stores the raw response head and payload separately as
        // base64 attributes.
        let farx = br#"<AutoResponder FiddlerVersion="5.0.1.0"><State>
          <ResponseRule Match="EXACT:http://162.55.220.72:5005/object_info_1"
            Action="*200-SESSION_1" Enabled="false"
            Headers="SFRUUC8xLjEgMjAwIEdlbmVyYXRlZA0KQ29udGVudC1MZW5ndGg6IDYyDQpDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24NCg0K"
            Body="ew0KICAgICJhZ2UiOiAyNiwNCiAgICAic2xlZXAiOiAxMjAuMCwNCiAgICAibmFtZSI6ICJTYXNoYSINCn0=" />
          </State></AutoResponder>"#;

        let export = parse_farx(farx).expect("public embedded-response shape imports");
        assert!(matches!(
            &export.scenarios[0].rules[0].action,
            Action::Respond {
                status: 200,
                body,
                content_type: Some(content_type),
                ..
            } if body.contains(r#""name": "Sasha""#) && content_type == "application/json"
        ));
    }

    #[test]
    fn rejects_everywhere_and_unsupported_classic_semantics_clearly() {
        let everywhere = br#"<AutoResponder RulesVersion="2"><State><ResponseRule Match="{}" Action="[]" /></State></AutoResponder>"#;
        let error = parse_farx(everywhere).unwrap_err().to_string();
        assert!(error.contains("Fiddler Everywhere FARX RulesVersion 2"));

        let encoded = br#"<AutoResponder><State><ResponseRule Match="{&quot;matches&quot;:[]}" Action="[]" /></State></AutoResponder>"#;
        let error = parse_farx(encoded).unwrap_err().to_string();
        assert!(error.contains("encoded Fiddler Everywhere rules"));

        let delay = br#"<AutoResponder><State><ResponseRule Match="regex:.*" Action="*delay:5000" /></State></AutoResponder>"#;
        let error = parse_farx(delay).unwrap_err().to_string();
        assert!(error.contains("*delay:5000"));

        let negated = br#"<AutoResponder><State><ResponseRule Match="NOT:example.test" Action="*404-NOTFOUND" /></State></AutoResponder>"#;
        let error = parse_farx(negated).unwrap_err().to_string();
        assert!(error.contains("NOT matchers"));

        let stored_without_payload = br#"<AutoResponder><State><ResponseRule Match="example.test" Action="*200-SESSION_28" /></State></AutoResponder>"#;
        let error = parse_farx(stored_without_payload).unwrap_err().to_string();
        assert!(error.contains("has no embedded Headers/Body payload"));

        let ambiguous_captures = br#"<AutoResponder><State><ResponseRule Match="regex:(?&lt;name&gt;a)(b)" Action="https://mock.test/$1" /></State></AutoResponder>"#;
        let error = parse_farx(ambiguous_captures).unwrap_err().to_string();
        assert!(error.contains("would change $n replacement numbering"));
    }

    #[test]
    fn rejects_malformed_or_empty_farx_without_panicking() {
        let malformed = parse_farx(b"<AutoResponder><State>")
            .unwrap_err()
            .to_string();
        assert!(malformed.contains("could not parse FARX XML") || malformed.contains("unclosed"));

        let empty = parse_farx(b"<AutoResponder><State /></AutoResponder>")
            .unwrap_err()
            .to_string();
        assert!(empty.contains("contains no AutoResponder rules"));

        let bad_body = br#"<AutoResponder><ResponseRule Match="x" Action="*200-OK" Body="%%%" /></AutoResponder>"#;
        let error = parse_farx(bad_body).unwrap_err().to_string();
        assert!(error.contains("Body is not valid base64"));

        let trailing = parse_farx(b"<AutoResponder><State /></AutoResponder>junk")
            .unwrap_err()
            .to_string();
        assert!(trailing.contains("content after AutoResponder"));
    }
}
