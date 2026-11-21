use std::net::IpAddr;
use tauri::Url;

pub const LAUNCHER_HOST: &str = "tauri.localhost";

pub fn parse_server_url(input: &str, allow_http: bool) -> Result<Url, &'static str> {
    let input = input.trim();
    if input.contains(char::is_whitespace) || input.contains('\\') {
        return Err("Enter a valid MusicDeck server URL.");
    }
    let url =
        Url::parse(input).map_err(|_| "Enter the full URL beginning with https:// or http://.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Use an HTTPS or HTTP MusicDeck server URL.");
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.');
    if host == "localhost"
        || host.ends_with(".localhost") && !matches!(host, LAUNCHER_HOST | "ipc.localhost")
        || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| {
            ip.is_loopback()
                || matches!(ip, IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback()))
        })
    {
        return Err("Localhost points to this phone. Use the server's LAN IP or domain.");
    }
    if url.scheme() == "http" && !allow_http {
        return Err("Use HTTPS. Plain HTTP is available in debug APKs for local testing.");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || matches!(host, LAUNCHER_HOST | "ipc.localhost")
    {
        return Err("Use the gateway address and port only, such as https://music.example.com.");
    }
    Ok(url)
}

pub fn is_launcher(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(LAUNCHER_HOST) && url.port().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_lan_and_hosted_gateways_with_correct_ports() {
        for (input, expected) in [
            ("http://192.168.1.50:8080", "http://192.168.1.50:8080/"),
            ("http://[fd00::1234]:8080", "http://[fd00::1234]:8080/"),
            (" https://MUSIC.example.com ", "https://music.example.com/"),
        ] {
            assert_eq!(parse_server_url(input, true).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn blocks_cleartext_in_release_and_rejects_non_gateway_urls() {
        assert!(parse_server_url("http://192.168.1.50:8080", false).is_err());
        for input in [
            "192.168.1.50:8080",
            "file:///index.html",
            "https://name:password@music.example.com",
            "https://music.example.com/api",
            "https://music.example.com/?key=secret",
            "https://music.example.com/#fragment",
            "https://tauri.localhost.",
            "https://ipc.localhost:1234",
            "https://domain.test\\override",
        ] {
            assert!(parse_server_url(input, true).is_err(), "{input}");
        }
        assert!(is_launcher(
            &Url::parse("https://tauri.localhost/").unwrap()
        ));
        assert!(!is_launcher(
            &Url::parse("http://tauri.localhost/").unwrap()
        ));
    }

    #[test]
    fn rejects_phone_loopback_without_changing_the_server_port() {
        for url in [
            "http://localhost:4534",
            "http://localhost.:4534",
            "http://127.0.0.2:8080",
            "http://[::1]:8080",
            "http://[::ffff:127.0.0.1]:8080",
        ] {
            assert!(parse_server_url(url, true)
                .unwrap_err()
                .contains("this phone"));
        }
        assert_eq!(
            parse_server_url("http://10.0.2.2:3000", true)
                .unwrap()
                .port(),
            Some(3000)
        );
    }
}
