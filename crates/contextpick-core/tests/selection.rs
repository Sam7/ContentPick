use contextpick_core::selection::{Intent, evaluate};
use std::collections::BTreeMap;

#[test]
fn hard_guard_beats_force_inclusion() {
    let intents = BTreeMap::from([("".into(), Intent::ForceInclude)]);
    let decision = evaluate("src/a.ts", Some("binary"), None, &intents);
    assert!(!decision.selected);
    assert_eq!(decision.reason.as_deref(), Some("binary"));
}

#[test]
fn nearest_intent_wins_without_crossing_path_boundaries() {
    let intents = BTreeMap::from([
        ("".into(), Intent::Include),
        ("src/tests".into(), Intent::Exclude),
        ("src/tests/one.ts".into(), Intent::Include),
    ]);
    assert!(!evaluate("src/tests/two.ts", None, None, &intents).selected);
    assert!(evaluate("src/tests/one.ts", None, None, &intents).selected);
    assert!(evaluate("src/testsOther/a.ts", None, None, &intents).selected);
}

#[test]
fn ordinary_include_obeys_filter_and_force_include_bypasses_it() {
    let mut intents = BTreeMap::from([("src".into(), Intent::Include)]);
    assert!(!evaluate("src/a.ts", None, Some("gitignore: *.ts"), &intents).selected);
    intents.insert("src/a.ts".into(), Intent::ForceInclude);
    assert!(evaluate("src/a.ts", None, Some("gitignore: *.ts"), &intents).force_included);
    assert!(
        !evaluate("src/a.ts", None, Some("gitignore: *.ts"), &intents)
            .reason
            .is_none()
    );
}

#[test]
fn force_exclusion_can_have_a_more_specific_exception() {
    let intents = BTreeMap::from([
        ("src".into(), Intent::ForceExclude),
        ("src/a.ts".into(), Intent::ForceInclude),
    ]);
    assert!(evaluate("src/a.ts", None, None, &intents).selected);
    assert!(!evaluate("src/b.ts", None, None, &intents).selected);
}

#[test]
fn hard_soft_and_intent_precedence_matches_the_complete_truth_table() {
    let cases = [
        (None, None, None, true, false, None),
        (None, None, Some(Intent::Include), true, false, None),
        (
            None,
            None,
            Some(Intent::Exclude),
            false,
            false,
            Some("excluded by user"),
        ),
        (
            None,
            None,
            Some(Intent::ForceInclude),
            true,
            true,
            Some("force included"),
        ),
        (
            None,
            None,
            Some(Intent::ForceExclude),
            false,
            false,
            Some("excluded by user"),
        ),
        (
            None,
            Some("soft filter"),
            None,
            false,
            false,
            Some("soft filter"),
        ),
        (
            None,
            Some("soft filter"),
            Some(Intent::Include),
            false,
            false,
            Some("soft filter"),
        ),
        (
            None,
            Some("soft filter"),
            Some(Intent::Exclude),
            false,
            false,
            Some("excluded by user"),
        ),
        (
            None,
            Some("soft filter"),
            Some(Intent::ForceInclude),
            true,
            true,
            Some("force included: soft filter"),
        ),
        (
            None,
            Some("soft filter"),
            Some(Intent::ForceExclude),
            false,
            false,
            Some("excluded by user"),
        ),
        (
            Some("hard guard"),
            None,
            None,
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            None,
            Some(Intent::Include),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            None,
            Some(Intent::Exclude),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            None,
            Some(Intent::ForceInclude),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            None,
            Some(Intent::ForceExclude),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            Some("soft filter"),
            None,
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            Some("soft filter"),
            Some(Intent::Include),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            Some("soft filter"),
            Some(Intent::Exclude),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            Some("soft filter"),
            Some(Intent::ForceInclude),
            false,
            false,
            Some("hard guard"),
        ),
        (
            Some("hard guard"),
            Some("soft filter"),
            Some(Intent::ForceExclude),
            false,
            false,
            Some("hard guard"),
        ),
    ];

    for (hard, soft, intent, selected, force_included, reason) in cases {
        let intents = intent.map_or_else(BTreeMap::new, |intent| {
            BTreeMap::from([(String::new(), intent)])
        });
        let decision = evaluate("src/file.ts", hard, soft, &intents);
        assert_eq!(
            decision.selected, selected,
            "hard={hard:?}, soft={soft:?}, intent={intent:?}"
        );
        assert_eq!(
            decision.force_included, force_included,
            "hard={hard:?}, soft={soft:?}, intent={intent:?}"
        );
        assert_eq!(
            decision.reason.as_deref(),
            reason,
            "hard={hard:?}, soft={soft:?}, intent={intent:?}"
        );
    }
}

proptest::proptest! {
    #[test]
    fn no_intent_can_bypass_hard_guard(path in "[a-z]{1,20}") {
        for intent in [Intent::Include, Intent::Exclude, Intent::ForceInclude, Intent::ForceExclude] {
            let intents = BTreeMap::from([(String::new(), intent)]);
            proptest::prop_assert!(!evaluate(&path, Some("unsafe link"), None, &intents).selected);
        }
    }
}
