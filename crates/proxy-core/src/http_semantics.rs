use hudsucker::hyper::header::{HeaderName, HeaderValue};

pub(crate) fn valid_header(name: &str, value: &str) -> bool {
    HeaderName::from_bytes(name.as_bytes()).is_ok()
        && HeaderValue::from_bytes(value.as_bytes()).is_ok()
}

/// Clamp a rule/script-supplied status to hyper's accepted range before it is
/// recorded or used to build the wire response.
pub(crate) fn sanitize_status(status: u16) -> u16 {
    if (100..=999).contains(&status) {
        status
    } else {
        200
    }
}

pub(crate) fn status_forbids_body(status: u16) -> bool {
    (100..200).contains(&status) || matches!(status, 204 | 205 | 304)
}

pub(crate) fn response_has_no_body(method: &str, status: u16) -> bool {
    method.eq_ignore_ascii_case("HEAD") || status_forbids_body(status)
}

pub(crate) fn is_framing_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("content-length")
        || name.eq_ignore_ascii_case("transfer-encoding")
        || name.eq_ignore_ascii_case("trailer")
}
