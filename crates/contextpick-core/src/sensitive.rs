use crate::{ManifestEntry, Result, content::checked_relative};
use serde::Serialize;

const CREDENTIAL_PATHS: &[&[&str]] = &[
    &[".aws", "credentials"],
    &[".config", "gcloud", "application_default_credentials.json"],
    &[".docker", "config.json"],
    &[".kube", "config"],
    &[".netrc"],
    &[".npmrc"],
    &[".pypirc"],
    &["credentials.json"],
    &["service-account.json"],
];

/// A filename-only warning category. These are heuristic indicators, not a
/// verdict that a file contains a secret.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SensitiveFileCategory {
    EnvironmentFile,
    PemMaterial,
    PrivateKey,
    CredentialFile,
}

/// Safe details to show before copying or exporting a selected file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveFileWarning {
    pub path: String,
    pub category: SensitiveFileCategory,
}

/// Identify common sensitive-file names in an already selected manifest.
///
/// This deliberately accepts no workspace or reader: it validates and inspects
/// path strings only and can never read source-file contents.
pub fn sensitive_file_warnings(entries: &[ManifestEntry]) -> Result<Vec<SensitiveFileWarning>> {
    let mut warnings = Vec::new();
    for entry in entries {
        checked_relative(&entry.path)?;
        if let Some(category) = category_for_path(&entry.path) {
            warnings.push(SensitiveFileWarning {
                path: entry.path.clone(),
                category,
            });
        }
    }
    Ok(warnings)
}

fn category_for_path(path: &str) -> Option<SensitiveFileCategory> {
    let name = path.rsplit('/').next().unwrap_or(path);

    if name.eq_ignore_ascii_case(".env")
        || name
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".env."))
    {
        return Some(SensitiveFileCategory::EnvironmentFile);
    }

    if path
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("pem"))
    {
        return Some(SensitiveFileCategory::PemMaterial);
    }

    if ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
        || path.rsplit_once('.').is_some_and(|(_, extension)| {
            extension.eq_ignore_ascii_case("key") || extension.eq_ignore_ascii_case("ppk")
        })
    {
        return Some(SensitiveFileCategory::PrivateKey);
    }

    if CREDENTIAL_PATHS
        .iter()
        .any(|suffix| path_ends_with(path, suffix))
    {
        return Some(SensitiveFileCategory::CredentialFile);
    }

    None
}

fn path_ends_with(path: &str, suffix: &[&str]) -> bool {
    let mut path_parts = path.rsplit('/');
    suffix.iter().rev().all(|expected| {
        path_parts
            .next()
            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
    })
}
