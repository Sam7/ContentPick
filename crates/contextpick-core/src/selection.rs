use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    Include,
    Exclude,
    ForceInclude,
    ForceExclude,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub selected: bool,
    pub force_included: bool,
    pub reason: Option<String>,
}

pub fn is_descendant(path: &str, ancestor: &str) -> bool {
    ancestor.is_empty()
        || path == ancestor
        || path
            .strip_prefix(ancestor)
            .is_some_and(|tail| tail.starts_with('/'))
}

pub fn effective_intent(path: &str, intents: &BTreeMap<String, Intent>) -> Option<Intent> {
    intents
        .iter()
        .filter(|(key, _)| is_descendant(path, key))
        .max_by_key(|(key, _)| key.len())
        .map(|(_, value)| *value)
}

pub fn evaluate(
    path: &str,
    hard: Option<&str>,
    soft: Option<&str>,
    intents: &BTreeMap<String, Intent>,
) -> Decision {
    let rejected = |reason: &str| Decision {
        selected: false,
        force_included: false,
        reason: Some(reason.into()),
    };
    if let Some(reason) = hard {
        return rejected(reason);
    }
    let intent = effective_intent(path, intents);
    match intent {
        Some(Intent::ForceExclude | Intent::Exclude) => rejected("excluded by user"),
        Some(Intent::ForceInclude) => Decision {
            selected: true,
            force_included: true,
            reason: Some(format!(
                "force included{}",
                soft.map(|s| format!(": {s}")).unwrap_or_default()
            )),
        },
        _ => match soft {
            Some(reason) => rejected(reason),
            None => Decision {
                selected: true,
                force_included: false,
                reason: None,
            },
        },
    }
}
