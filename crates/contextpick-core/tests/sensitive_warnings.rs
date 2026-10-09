use contextpick_core::{
    ManifestEntry,
    selection::Intent,
    sensitive::{SensitiveFileCategory, sensitive_file_warnings},
    workspace::{FilterPolicy, Workspace},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    sync::atomic::AtomicBool,
};

fn entry(path: &str) -> ManifestEntry {
    ManifestEntry {
        path: path.to_owned(),
        size: 0,
        modified_ns: 0,
    }
}

#[test]
fn warns_for_documented_sensitive_filename_patterns() {
    let cases = [
        (".env", SensitiveFileCategory::EnvironmentFile),
        ("config/.env.local", SensitiveFileCategory::EnvironmentFile),
        ("CONFIG/.ENV.PROD", SensitiveFileCategory::EnvironmentFile),
        (
            "examples/.env.example",
            SensitiveFileCategory::EnvironmentFile,
        ),
        ("deploy/certificate.pem", SensitiveFileCategory::PemMaterial),
        (".ssh/id_rsa", SensitiveFileCategory::PrivateKey),
        (".ssh/ID_ED25519", SensitiveFileCategory::PrivateKey),
        ("keys/deploy.key", SensitiveFileCategory::PrivateKey),
        ("keys/deploy.ppk", SensitiveFileCategory::PrivateKey),
        (".aws/credentials", SensitiveFileCategory::CredentialFile),
        (
            "Examples/.AWS/CREDENTIALS",
            SensitiveFileCategory::CredentialFile,
        ),
        (
            ".config/gcloud/application_default_credentials.json",
            SensitiveFileCategory::CredentialFile,
        ),
        (".docker/config.json", SensitiveFileCategory::CredentialFile),
        (".kube/config", SensitiveFileCategory::CredentialFile),
        (".netrc", SensitiveFileCategory::CredentialFile),
        (".npmrc", SensitiveFileCategory::CredentialFile),
        (".pypirc", SensitiveFileCategory::CredentialFile),
        ("credentials.json", SensitiveFileCategory::CredentialFile),
        (
            "service-account.json",
            SensitiveFileCategory::CredentialFile,
        ),
    ];

    for (path, category) in cases {
        let warnings = sensitive_file_warnings(&[entry(path)]).unwrap();
        assert_eq!(warnings.len(), 1, "{path}");
        assert_eq!(warnings[0].path, path, "{path}");
        assert_eq!(warnings[0].category, category, "{path}");
    }
}

#[test]
fn does_not_warn_for_unrelated_names_or_public_ssh_keys() {
    let paths = [
        "src/environment.ts",
        "src/my-secret.txt",
        "src/.envoy",
        "keys/id_ed25519.pub",
        "src/credentials.rs",
        "examples/credentials-not-real.json",
        "docs/pem-notes.md",
    ];
    let warnings = sensitive_file_warnings(&paths.map(entry)).unwrap();
    assert!(warnings.is_empty());
}

#[test]
fn rejects_noncanonical_manifest_paths_instead_of_normalizing_them() {
    for path in [r"config\.env", "config/../.env", "./.env"] {
        assert!(
            sensitive_file_warnings(&[entry(path)]).is_err(),
            "accepted noncanonical path {path:?}"
        );
    }
}

#[test]
fn warnings_return_only_selected_paths_and_safe_categories() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("selected")).unwrap();
    fs::create_dir_all(temp.path().join("ignored")).unwrap();
    fs::create_dir_all(temp.path().join("excluded")).unwrap();
    fs::write(temp.path().join(".gitignore"), "ignored/\n").unwrap();
    fs::write(
        temp.path().join("selected/.env"),
        "SYNTHETIC_BODY_SENTINEL=never-return-this",
    )
    .unwrap();
    fs::write(
        temp.path().join("ignored/.env"),
        "synthetic ignored fixture",
    )
    .unwrap();
    fs::write(
        temp.path().join("excluded/private.pem"),
        "synthetic excluded fixture",
    )
    .unwrap();
    fs::write(
        temp.path().join("generated.pem"),
        "synthetic generated fixture",
    )
    .unwrap();
    fs::write(temp.path().join("binary.pem"), [0, 0xff, b'k', b'e', b'y']).unwrap();
    fs::write(
        temp.path().join("ordinary.txt"),
        "synthetic ordinary fixture",
    )
    .unwrap();

    let workspace = Workspace::scan_with_outputs(
        temp.path(),
        FilterPolicy::default(),
        BTreeMap::from([
            ("excluded".into(), Intent::ForceExclude),
            ("generated.pem".into(), Intent::ForceInclude),
            ("binary.pem".into(), Intent::ForceInclude),
        ]),
        BTreeSet::new(),
        BTreeSet::from(["generated.pem".into()]),
        &AtomicBool::new(false),
    )
    .unwrap();
    let manifest = workspace.manifest();
    let warnings = sensitive_file_warnings(&manifest).unwrap();

    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].path, "selected/.env");
    assert_eq!(warnings[0].category, SensitiveFileCategory::EnvironmentFile);

    let json = serde_json::to_value(&warnings).unwrap();
    let warning = &json[0];
    assert_eq!(warning["path"], "selected/.env");
    assert_eq!(warning["category"], "environmentFile");
    assert!(warning.get("size").is_none());
    assert!(warning.get("modifiedNs").is_none());
    assert!(!json.to_string().contains("SYNTHETIC_BODY_SENTINEL"));
}
