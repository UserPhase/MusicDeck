//! # Network & Trusted Proxy CIDR Validation (`config::network`)
//!
//! Ports the reverse-proxy trust boundary and listener binding rules from
//! `server/src/config.ts`.
//!
//! ## Security Invariants
//! - If `MUSICDECK_TRUSTED_PROXIES` is empty or unset, forwarding headers
//!   (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`) are never trusted.
//! - Every comma-separated entry in `MUSICDECK_TRUSTED_PROXIES` must be either an
//!   explicit IPv4/IPv6 host address (`127.0.0.1`, `::1`) or an explicit CIDR block
//!   (`10.0.0.0/8`, `172.16.0.0/12`, `fd00::/8`).
//! - Wildcard `/0` prefixes (`0.0.0.0/0`, `::/0`), hostnames (`localhost`), malformed
//!   slashes (`127.0.0.1/`), and out-of-range prefix lengths (`10.0.0.1/33`) are
//!   rejected at startup with [`ConfigError::InvalidTrustedProxy`].

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::ConfigError;

/// Default bind IP address (`127.0.0.1`) matching `server/src/config.ts`.
pub const DEFAULT_HOST: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// Default TCP listening port (`4534`) matching `server/src/config.ts`.
pub const DEFAULT_PORT: u16 = 4534;

/// A validated proxy entry representing either a single IP address or a CIDR subnet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedProxyEntry {
    /// Original normalized text representation (e.g., `"127.0.0.1"` or `"10.20.0.0/24"`).
    pub raw: String,
    /// Parsed network range used for $O(1)$ bitwise subnet membership checks.
    pub network: IpNet,
}

impl TrustedProxyEntry {
    /// Parses a single proxy specification string into a [`TrustedProxyEntry`].
    pub fn parse(entry: &str) -> Result<Self, ConfigError> {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return Err(ConfigError::InvalidTrustedProxy {
                entry: String::new(),
                reason: String::from(
                    "MUSICDECK_TRUSTED_PROXIES must not contain empty comma-separated entries",
                ),
            });
        }

        let mut parts = trimmed.split('/');
        let addr_part = parts.next().unwrap_or_default();
        let prefix_part = parts.next();
        let extra_part = parts.next();

        if extra_part.is_some() {
            return Err(ConfigError::InvalidTrustedProxy {
                entry: trimmed.to_owned(),
                reason: String::from(
                    "MUSICDECK_TRUSTED_PROXIES must contain only explicit IP addresses or CIDRs",
                ),
            });
        }

        let ip: IpAddr = addr_part.parse().map_err(|_| ConfigError::InvalidTrustedProxy {
            entry: trimmed.to_owned(),
            reason: String::from(
                "MUSICDECK_TRUSTED_PROXIES must contain only explicit IP addresses or CIDRs",
            ),
        })?;

        let max_prefix: u8 = match ip {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };

        let prefix_len = if let Some(prefix_str) = prefix_part {
            if prefix_str.is_empty() || !prefix_str.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ConfigError::InvalidTrustedProxy {
                    entry: trimmed.to_owned(),
                    reason: String::from(
                        "MUSICDECK_TRUSTED_PROXIES must contain only explicit IP addresses or CIDRs",
                    ),
                });
            }
            let parsed_prefix: u8 =
                prefix_str
                    .parse()
                    .map_err(|_| ConfigError::InvalidTrustedProxy {
                        entry: trimmed.to_owned(),
                        reason: String::from(
                            "MUSICDECK_TRUSTED_PROXIES prefix length exceeds valid bounds",
                        ),
                    })?;
            if parsed_prefix > max_prefix {
                return Err(ConfigError::InvalidTrustedProxy {
                    entry: trimmed.to_owned(),
                    reason: String::from(
                        "MUSICDECK_TRUSTED_PROXIES must contain only explicit IP addresses or CIDRs",
                    ),
                });
            }
            if parsed_prefix == 0 {
                return Err(ConfigError::InvalidTrustedProxy {
                    entry: trimmed.to_owned(),
                    reason: String::from(
                        "MUSICDECK_TRUSTED_PROXIES must not trust all network addresses (/0)",
                    ),
                });
            }
            parsed_prefix
        } else {
            max_prefix
        };

        let network =
            IpNet::new(ip, prefix_len).map_err(|_| ConfigError::InvalidTrustedProxy {
                entry: trimmed.to_owned(),
                reason: String::from("Invalid CIDR network specification"),
            })?;

        Ok(Self {
            raw: trimmed.to_owned(),
            network,
        })
    }

    /// Returns `true` if `ip` falls within this proxy's host address or CIDR block.
    #[must_use]
    pub fn contains(&self, ip: &IpAddr) -> bool {
        self.network.contains(ip)
    }
}

/// Parses the comma-separated `MUSICDECK_TRUSTED_PROXIES` environment value.
pub fn parse_trusted_proxies(raw: &str) -> Result<Vec<TrustedProxyEntry>, ConfigError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    trimmed.split(',').map(TrustedProxyEntry::parse).collect()
}

/// Network listener, origin, and reverse-proxy trust configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkConfig {
    /// Interface IP address to bind (`MUSICDECK_HOST`, defaults to `127.0.0.1`).
    pub host: IpAddr,
    /// TCP listener port (`MUSICDECK_PORT`, defaults to `4534`).
    pub port: u16,
    /// Public browser-facing URL (`MUSICDECK_PUBLIC_URL`).
    pub public_url: String,
    /// Allowed CORS origin (`MUSICDECK_CORS_ORIGIN`).
    pub cors_origin: String,
    /// Whether outbound external network calls are blocked (`LOCAL_ONLY_MODE`).
    pub local_only_mode: bool,
    /// Explicit reverse-proxy IPs and CIDR subnets permitted to supply `X-Forwarded-*`.
    pub trusted_proxies: Vec<TrustedProxyEntry>,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST,
            port: DEFAULT_PORT,
            public_url: String::from("http://localhost:4534"),
            cors_origin: String::from("http://localhost:3000"),
            local_only_mode: false,
            trusted_proxies: Vec::new(),
        }
    }
}

impl NetworkConfig {
    /// Returns the [`SocketAddr`] for binding `tokio::net::TcpListener`.
    #[must_use]
    pub const fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }

    /// Returns the raw string list of trusted proxies matching `AppConfig.trustedProxies`
    /// in the legacy TypeScript server.
    #[must_use]
    pub fn trusted_proxy_strings(&self) -> Vec<String> {
        self.trusted_proxies.iter().map(|p| p.raw.clone()).collect()
    }

    /// Checks whether a connecting peer IP address belongs to a configured trusted proxy.
    #[must_use]
    pub fn is_trusted_proxy(&self, ip: &IpAddr) -> bool {
        self.trusted_proxies.iter().any(|entry| entry.contains(ip))
    }

    /// Resolves the effective client IP address from the immediate socket `peer_ip` and
    /// an optional `X-Forwarded-For` header value, walking right-to-left across trusted
    /// hops so untrusted clients cannot spoof left-hand `X-Forwarded-For` entries.
    #[must_use]
    pub fn resolve_client_ip(&self, peer_ip: IpAddr, x_forwarded_for: Option<&str>) -> IpAddr {
        if !self.is_trusted_proxy(&peer_ip) {
            return peer_ip;
        }

        let Some(header) = x_forwarded_for else {
            return peer_ip;
        };

        let Ok(hops) = header
            .split(',')
            .map(|part| part.trim().parse::<IpAddr>().map(|ip| ip.to_canonical()))
            .collect::<Result<Vec<_>, _>>()
        else {
            return peer_ip;
        };

        if hops.is_empty() {
            return peer_ip;
        }

        for candidate in hops.iter().rev() {
            if !self.is_trusted_proxy(candidate) {
                return *candidate;
            }
        }

        hops[0]
    }
}

/// Validates that an endpoint URL uses `http:` or `https:` and contains no embedded
/// credentials, query strings, or URL fragments (matching `systemConfiguration.ts`).
pub fn validate_clean_http_endpoint(field: &str, value: &str) -> Result<(), ConfigError> {
    if value.is_empty() || value.len() > 2048 {
        return Err(ConfigError::InvalidUrl {
            field: field.to_owned(),
            reason: String::from("URL must be between 1 and 2048 characters"),
        });
    }

    let parsed = Url::parse(value).map_err(|err| ConfigError::InvalidUrl {
        field: field.to_owned(),
        reason: err.to_string(),
    })?;

    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ConfigError::InvalidUrl {
            field: field.to_owned(),
            reason: String::from(
                "Use an HTTP(S) server URL without embedded credentials, query parameters, or fragments.",
            ),
        });
    }

    Ok(())
}
