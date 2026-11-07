//! # HTTP Byte-Range & Media Streaming Utilities (`streaming`)

pub mod http;

pub use http::{
    ALLOWED_PROXY_HEADERS, ByteRange, RangeParseError, STREAM_CHUNK_SIZE, parse_byte_range,
    proxy_upstream_stream, send_error_response, serve_file_with_range,
};
