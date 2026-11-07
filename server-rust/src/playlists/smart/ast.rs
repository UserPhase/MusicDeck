//! # Smart Playlist Rule AST & Bounded Tree Validator (`playlists::smart::ast`)
//!
//! Complete Rust port of `server/src/types/smart-playlist.ts`.
//!
//! ## Safety & Structural Bounds
//! 1. **Pre-Validation Iterative DFS Guard ([`parse_smart_playlist_rule`])**:
//!    - Before recursive deserialization or SQL compilation runs, an explicit stack-based
//!      traversal verifies that the JSON tree contains at most [`MAX_RULE_NODES`] (`100`)
//!      total nodes and at most [`MAX_RULE_DEPTH`] (`6`) nested group levels, and that
//!      every group contains `1..=100` child rules. Malicious deeply nested JSON payloads
//!      cannot overflow the call stack.
//! 2. **Strict Field/Operator/Value Type Compatibility**:
//!    - **Text fields** (`title`, `artist`, `album`, `genre`): `equals` | `not_equals` | `contains`,
//!      `1..=300` trimmed chars; `genre` values cannot contain the unit separator `\u{001f}`.
//!    - **Numeric fields** (`year`, `era_year`, `bpm`, `play_count`, `skip_count`):
//!      `equals` | `not_equals` | `greater_than` | `less_than`, finite value in `0..=1_000_000_000`
//!      (integer required for all except `bpm`).
//!    - **Boolean field** (`is_favorite`): `equals` | `not_equals` with a `bool`.
//!    - **Timestamp & Relative Date field** (`last_played`):
//!      - `equals` | `not_equals` | `greater_than` | `less_than` with an RFC 3339 datetime string.
//!      - `in_last_days` | `not_in_last_days` with an integer in `1..=36500`.
//!    - **Seed Similarity field** (`similar_to`): `matches` with a `1..=500` trimmed track ID string.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::db::DbError;

/// Maximum total AST nodes permitted in a smart playlist rule tree (`100`).
pub const MAX_RULE_NODES: usize = 100;

/// Maximum nesting depth permitted in a smart playlist rule tree (`6`).
pub const MAX_RULE_DEPTH: usize = 6;

/// Target field selector in a [`LeafRule`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmartPlaylistField {
    /// Metadata similarity to a seed track ID (`similar_to`).
    SimilarTo,
    /// Track title (`title`).
    Title,
    /// Track artist (`artist`).
    Artist,
    /// Track album (`album`).
    Album,
    /// Track genre (`genre`).
    Genre,
    /// Release year (`year`).
    Year,
    /// Original release year with fallback to release year (`era_year`).
    EraYear,
    /// Tempo in beats per minute (`bpm`).
    Bpm,
    /// User's total play count for the track (`play_count`).
    PlayCount,
    /// User's total skip count for the track (`skip_count`).
    SkipCount,
    /// Whether the user has favorited the track (`is_favorite`).
    IsFavorite,
    /// User's last played timestamp for the track (`last_played`).
    LastPlayed,
}

impl SmartPlaylistField {
    /// Parses a field identifier string.
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw {
            "similar_to" => Some(Self::SimilarTo),
            "title" => Some(Self::Title),
            "artist" => Some(Self::Artist),
            "album" => Some(Self::Album),
            "genre" => Some(Self::Genre),
            "year" => Some(Self::Year),
            "era_year" => Some(Self::EraYear),
            "bpm" => Some(Self::Bpm),
            "play_count" => Some(Self::PlayCount),
            "skip_count" => Some(Self::SkipCount),
            "is_favorite" => Some(Self::IsFavorite),
            "last_played" => Some(Self::LastPlayed),
            _ => None,
        }
    }

    /// Returns the wire string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SimilarTo => "similar_to",
            Self::Title => "title",
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Genre => "genre",
            Self::Year => "year",
            Self::EraYear => "era_year",
            Self::Bpm => "bpm",
            Self::PlayCount => "play_count",
            Self::SkipCount => "skip_count",
            Self::IsFavorite => "is_favorite",
            Self::LastPlayed => "last_played",
        }
    }
}

/// Comparison operator in a [`LeafRule`] (`FieldOperator`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldOperator {
    /// Exact equality (`=`, case-insensitive on text).
    Equals,
    /// Inequality (`!=`, case-insensitive on text).
    NotEquals,
    /// Substring match (`LIKE %...% ESCAPE '\'`).
    Contains,
    /// Strictly greater than (`>`).
    GreaterThan,
    /// Strictly less than (`<`).
    LessThan,
    /// Played within the last $N$ days.
    InLastDays,
    /// Not played within the last $N$ days (or never played).
    NotInLastDays,
    /// Seed similarity match (`similar_to matches <seed_id>`).
    Matches,
}

impl FieldOperator {
    /// Parses an operator string.
    #[must_use]
    pub fn parse_str(raw: &str) -> Option<Self> {
        match raw {
            "equals" => Some(Self::Equals),
            "not_equals" => Some(Self::NotEquals),
            "contains" => Some(Self::Contains),
            "greater_than" => Some(Self::GreaterThan),
            "less_than" => Some(Self::LessThan),
            "in_last_days" => Some(Self::InLastDays),
            "not_in_last_days" => Some(Self::NotInLastDays),
            "matches" => Some(Self::Matches),
            _ => None,
        }
    }
}

/// Boolean combinator for nested rule groups (`LogicalOperator`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LogicalOperator {
    /// Logical conjunction (`AND`).
    #[serde(rename = "AND")]
    And,
    /// Logical disjunction (`OR`).
    #[serde(rename = "OR")]
    Or,
}

impl LogicalOperator {
    /// Returns `"AND"` or `"OR"`.
    #[must_use]
    pub const fn as_sql(self) -> &'static str {
        match self {
            Self::And => "AND",
            Self::Or => "OR",
        }
    }
}

/// Strongly typed literal operand inside a [`LeafRule`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuleValue {
    /// Text or ISO-8601 datetime literal.
    Text(String),
    /// Integer literal (years, play/skip counts, relative days).
    Int(i64),
    /// Floating-point literal (`bpm`).
    Float(f64),
    /// Boolean literal (`is_favorite`).
    Bool(bool),
}

/// Validated leaf predicate `(field, operator, value)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeafRule {
    /// Target track or activity field.
    pub field: SmartPlaylistField,
    /// Comparison operator.
    pub operator: FieldOperator,
    /// Validated literal operand.
    pub value: RuleValue,
}

/// Recursive Smart Playlist Abstract Syntax Tree node (`RuleNode` / `SmartPlaylistRule`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuleNode {
    /// Composite boolean group (`AND` / `OR`).
    Group {
        /// Boolean operator combining `rules`.
        operator: LogicalOperator,
        /// Non-empty list of child rules (`1..=100`).
        rules: Vec<RuleNode>,
    },
    /// Single field comparison predicate.
    Leaf(LeafRule),
}

/// Ordering strategy for guided smart playlist mixes (`MixOptions.order`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MixOrder {
    /// Pseudo-random seeded FNV-1a ordering (`musicdeck_mix_rank`).
    Variety,
    /// Ranked by shared artist, shared genre count, and BPM proximity to the `similar_to` seed.
    Similar,
    /// Ranked by oldest `last_played` timestamp first (`last_played ASC`).
    Rediscover,
}

/// Guided mix sampling and ordering options (`mixOptionsSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MixOptions {
    /// Maximum tracks to select (`10..=200`).
    pub size: usize,
    /// Ordering strategy (`variety`, `similar`, `rediscover`).
    pub order: MixOrder,
    /// Deterministic PRNG/hash seed (`0..=2_147_483_647`).
    pub seed: u32,
}

impl MixOptions {
    /// Validates `size` (`10..=200`) and `seed` (`<= i32::MAX as u32`).
    pub fn validate(&self) -> Result<(), SmartPlaylistError> {
        if !(10..=200).contains(&self.size) || self.seed > 2_147_483_647 {
            return Err(SmartPlaylistError::InvalidRule(String::from(
                "Invalid mix options: size must be 10-200 and seed 0-2147483647.",
            )));
        }
        Ok(())
    }
}

/// Persisted smart playlist definition (`SmartPlaylistDefinition`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPlaylistDefinition {
    /// Smart playlist ID (`smart_<nanoid>`).
    pub id: String,
    /// Display name (`1..=200` trimmed chars).
    pub name: String,
    /// Validated AST rule tree.
    pub rules: RuleNode,
    /// Creation timestamp.
    pub created_at: String,
    /// Last update timestamp.
    pub updated_at: String,
    /// Optional guided mix options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<MixOptions>,
}

/// Error taxonomy for smart playlist AST parsing, compilation, and evaluation.
#[derive(Debug, Error)]
pub enum SmartPlaylistError {
    /// Malformed or unsafe rule tree (`400 Bad Request`, `VALIDATION_ERROR`).
    #[error("{0}")]
    InvalidRule(String),

    /// Smart playlist not found (`404 Not Found`).
    #[error("Smart playlist not found")]
    NotFound,

    /// Selection token changed between preview and snapshot save (`409 Conflict`, `MIX_CHANGED`).
    #[error("{0}")]
    MixChanged(String),

    /// Catalog index has not completed its initial refresh (`503 Service Unavailable`).
    #[error("{0}")]
    ServiceUnavailable(String),

    /// Database error.
    #[error(transparent)]
    Db(#[from] DbError),

    /// Raw SQLx error.
    #[error("Smart playlist database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Validates and parses an untrusted JSON value into a [`RuleNode`] AST, enforcing
/// the `<= 100` node and `<= 6` nesting depth bounds prior to recursive validation.
pub fn parse_smart_playlist_rule(input: &Value) -> Result<RuleNode, SmartPlaylistError> {
    let mut stack: Vec<(&Value, usize)> = vec![(input, 0)];
    let mut node_count = 0usize;

    while let Some((current, depth)) = stack.pop() {
        node_count += 1;
        if node_count > MAX_RULE_NODES || depth > MAX_RULE_DEPTH {
            return Err(SmartPlaylistError::InvalidRule(String::from(
                "Rules may contain at most 100 nodes and 6 nested levels.",
            )));
        }

        let Some(obj) = current.as_object() else {
            return Err(SmartPlaylistError::InvalidRule(String::from(
                "Invalid rules. Check field/operator compatibility, values, and non-empty groups.",
            )));
        };

        if let Some(children_val) = obj.get("rules") {
            let Some(children) = children_val.as_array() else {
                return Err(SmartPlaylistError::InvalidRule(String::from(
                    "Invalid rules. Check field/operator compatibility, values, and non-empty groups.",
                )));
            };
            if children.len() > MAX_RULE_NODES {
                return Err(SmartPlaylistError::InvalidRule(String::from(
                    "A group may contain at most 100 rules.",
                )));
            }
            for child in children {
                stack.push((child, depth + 1));
            }
        }
    }

    parse_node_recursive(input)
}

fn parse_node_recursive(value: &Value) -> Result<RuleNode, SmartPlaylistError> {
    let invalid = || {
        SmartPlaylistError::InvalidRule(String::from(
            "Invalid rules. Check field/operator compatibility, values, and non-empty groups.",
        ))
    };

    let obj = value.as_object().ok_or_else(invalid)?;

    if obj.contains_key("rules") {
        if obj.len() != 2 || !obj.contains_key("operator") {
            return Err(invalid());
        }
        let op = match obj.get("operator").and_then(Value::as_str) {
            Some("AND") => LogicalOperator::And,
            Some("OR") => LogicalOperator::Or,
            _ => return Err(invalid()),
        };
        let raw_rules = obj.get("rules").and_then(Value::as_array).ok_or_else(invalid)?;
        if raw_rules.is_empty() || raw_rules.len() > MAX_RULE_NODES {
            return Err(invalid());
        }
        let mut parsed_children = Vec::with_capacity(raw_rules.len());
        for child in raw_rules {
            parsed_children.push(parse_node_recursive(child)?);
        }
        return Ok(RuleNode::Group {
            operator: op,
            rules: parsed_children,
        });
    }

    if obj.len() != 3 {
        return Err(invalid());
    }

    let field_str = obj.get("field").and_then(Value::as_str).ok_or_else(invalid)?;
    let op_str = obj
        .get("operator")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let raw_val = obj.get("value").ok_or_else(invalid)?;

    let field = SmartPlaylistField::parse_str(field_str).ok_or_else(invalid)?;
    let operator = FieldOperator::parse_str(op_str).ok_or_else(invalid)?;

    match field {
        SmartPlaylistField::Title
        | SmartPlaylistField::Artist
        | SmartPlaylistField::Album
        | SmartPlaylistField::Genre => {
            if !matches!(
                operator,
                FieldOperator::Equals | FieldOperator::NotEquals | FieldOperator::Contains
            ) {
                return Err(invalid());
            }
            let s = raw_val.as_str().ok_or_else(invalid)?.trim();
            if s.is_empty() || s.chars().count() > 300 {
                return Err(invalid());
            }
            if field == SmartPlaylistField::Genre && s.contains('\u{001f}') {
                return Err(SmartPlaylistError::InvalidRule(String::from(
                    "Genre values cannot contain control separators",
                )));
            }
            Ok(RuleNode::Leaf(LeafRule {
                field,
                operator,
                value: RuleValue::Text(s.to_owned()),
            }))
        }
        SmartPlaylistField::Year
        | SmartPlaylistField::EraYear
        | SmartPlaylistField::PlayCount
        | SmartPlaylistField::SkipCount => {
            if !matches!(
                operator,
                FieldOperator::Equals
                    | FieldOperator::NotEquals
                    | FieldOperator::GreaterThan
                    | FieldOperator::LessThan
            ) {
                return Err(invalid());
            }
            let num = extract_integer_value(raw_val).ok_or_else(invalid)?;
            if !(0..=1_000_000_000).contains(&num) {
                return Err(invalid());
            }
            Ok(RuleNode::Leaf(LeafRule {
                field,
                operator,
                value: RuleValue::Int(num),
            }))
        }
        SmartPlaylistField::Bpm => {
            if !matches!(
                operator,
                FieldOperator::Equals
                    | FieldOperator::NotEquals
                    | FieldOperator::GreaterThan
                    | FieldOperator::LessThan
            ) {
                return Err(invalid());
            }
            let num = raw_val
                .as_f64()
                .filter(|v| v.is_finite() && (0.0..=1_000_000_000.0).contains(v))
                .ok_or_else(invalid)?;
            Ok(RuleNode::Leaf(LeafRule {
                field,
                operator,
                value: RuleValue::Float(num),
            }))
        }
        SmartPlaylistField::IsFavorite => {
            if !matches!(operator, FieldOperator::Equals | FieldOperator::NotEquals) {
                return Err(invalid());
            }
            let b = raw_val.as_bool().ok_or_else(invalid)?;
            Ok(RuleNode::Leaf(LeafRule {
                field,
                operator,
                value: RuleValue::Bool(b),
            }))
        }
        SmartPlaylistField::LastPlayed => match operator {
            FieldOperator::Equals
            | FieldOperator::NotEquals
            | FieldOperator::GreaterThan
            | FieldOperator::LessThan => {
                let s = raw_val.as_str().ok_or_else(invalid)?;
                if DateTime::parse_from_rfc3339(s).is_err() {
                    return Err(invalid());
                }
                Ok(RuleNode::Leaf(LeafRule {
                    field,
                    operator,
                    value: RuleValue::Text(s.to_owned()),
                }))
            }
            FieldOperator::InLastDays | FieldOperator::NotInLastDays => {
                let days = extract_integer_value(raw_val).ok_or_else(invalid)?;
                if !(1..=36_500).contains(&days) {
                    return Err(invalid());
                }
                Ok(RuleNode::Leaf(LeafRule {
                    field,
                    operator,
                    value: RuleValue::Int(days),
                }))
            }
            _ => Err(invalid()),
        },
        SmartPlaylistField::SimilarTo => {
            if operator != FieldOperator::Matches {
                return Err(invalid());
            }
            let s = raw_val.as_str().ok_or_else(invalid)?.trim();
            if s.is_empty() || s.chars().count() > 500 {
                return Err(invalid());
            }
            Ok(RuleNode::Leaf(LeafRule {
                field,
                operator,
                value: RuleValue::Text(s.to_owned()),
            }))
        }
    }
}

fn extract_integer_value(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    if f.is_finite() && f.fract() == 0.0 && f >= (i64::MIN as f64) && f <= (i64::MAX as f64) {
        #[allow(clippy::cast_possible_truncation)]
        Some(f as i64)
    } else {
        None
    }
}
