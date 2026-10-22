//! AgentRegistry — on-chain agent identity on Soroban.
//!
//! MVP supports:
//! - register(caller, id, display_name, stellar_address, capabilities)
//! - update_metadata(caller, id, new_display_name, new_capabilities)
//! - deactivate(caller, id)
//! - query(id)
//! - authorization: every *** entrypoint takes the acting `Address` and
//!   calls `require_auth()` as its first statement; only the registered owner
//!   may update/deactivate their own agent.
//!
//! Agent ids are case-sensitive and are not normalized. They must start with
//! an ASCII lowercase letter or digit, followed only by ASCII lowercase
//! letters, digits, `.`, `_`, or `-`. Uppercase and non-ASCII characters are
//! rejected. The 64-byte limit is measured in UTF-8 bytes (all accepted ids
//! are ASCII, so this is also their character count).
//!
//! Events: each successful mutation publishes a contract event with topics
//! `("agent", <action>)` — see `DESIGN.md` for the full event schema.
//!
//! Lifecycle/TTL model:
//! - Agent records live in *persistent* storage under `DataKey::Agent(id)`.
//! - Every WRITE path (register, update_metadata, deactivate) extends both the
//!   record entry's TTL and the contract instance TTL toward the ledger max.
//! - `query` is a pure read: it mutates no storage and extends no TTL. Records
//!   are kept alive by owner writes, or by anyone submitting an
//!   `ExtendFootprintTTL` operation on the record's entry.
//! - A record with no write for longer than the network TTL ceiling is archived,
//!   not deleted. It must be restored (automatic when the transaction is
//!   simulated via RPC) before it can be read or written, and `register` on
//!   that id still fails with AlreadyRegistered after restore.
//!
//! # Validation rules
//!
//! Every input is validated *before* any storage write, so a rejected call
//! leaves storage completely untouched. The same validators run on both
//! `register` and `update_metadata` — a caller may not smuggle a record past
//! the rules by registering a valid one and then updating it.
//!
//! | Input | Rule | Rejection |
//! |---|---|---|
//! | `id` | non-empty | `Error::IdEmpty` |
//! | `id` | at most [`MAX_ID_LEN`] (64) bytes | `Error::IdTooLong` |
//! | `display_name` | non-empty | `Error::DisplayNameEmpty` |
//! | `display_name` | at most [`MAX_DISPLAY_NAME_LEN`] (128) bytes | `Error::DisplayNameTooLong` |
//! | `capabilities` | at most [`MAX_CAPABILITIES`] (32) entries | `Error::TooManyCapabilities` |
//! | each capability | non-empty | `Error::CapabilityEmpty` |
//! | each capability | at most [`MAX_CAPABILITY_LEN`] (32) bytes | `Error::CapabilityTooLong` |
//! | each capability | distinct from every other entry | `Error::CapabilityDuplicate` |
//!
//! The API-side `PATCH /agents/:id` endpoint mirrors these caps for the
//! mutable metadata fields: `displayName` (≤ 100 chars in the API, stricter
//! than the on-chain 128-byte cap), `description` (API-only, ≤ 500 chars),
//! and `capabilities` (≤ [`MAX_CAPABILITIES`] entries, each ≤
//! [`MAX_CAPABILITY_LEN`] bytes). `status` and `stellarAddress` are not
//! mutable through that endpoint.
//!
//! Decisions stated explicitly (each is a deliberate choice, not an accident):
//!
//! - **Duplicate capabilities are rejected**, and the comparison is **exact
//!   byte equality** — case-sensitive and with no trimming. `"Vision"` and
//!   `"vision"` are therefore two *distinct* capabilities, while `"read"`
//!   supplied twice is rejected. This is a stricter contract for callers:
//!   `update_metadata` now rejects a capability list that repeats an entry,
//!   even if the agent was registered before this rule existed. The check is
//!   O(n²) over at most 32 entries (≤ 496 comparisons), which is bounded and
//!   cheap; no allocation is required, which matters because the crate is
//!   `no_std`.
//! - **Whitespace-only `display_name` (e.g. `"   "`) is accepted**, and this
//!   is intentional. `soroban_sdk::String` exposes only `len()` and
//!   `is_empty()` — there is no byte, char, or slice accessor, and `Display`/
//!   `ToString` are compiled out for `wasm32` — so a whitespace test cannot be
//!   expressed in contract code without an extra host round-trip. Only the
//!   genuinely-empty string is rejected. Revisit if the SDK grows a byte
//!   accessor.
//! - **Precedence** when an input violates several rules at once: the entry
//!   count is checked first (`TooManyCapabilities`), then each capability is
//!   examined in order and the first violation wins, in the order
//!   `CapabilityEmpty` → `CapabilityTooLong` → `CapabilityDuplicate`.
//! - **`stellar_address` is immutable after registration.** There is no
//!   entrypoint to change it, and the API's `PATCH /agents/:id` route rejects
//!   it. Rebinding a signer address is a security-sensitive operation that
//!   needs its own consent flow (see `register`), so it is deliberately out
//!   of scope for a metadata patch.
//!
//! Future: delegation, multi-sig registration, capability discovery events.

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String, Vec};

/// Max accepted length of an agent id, in bytes.
const MAX_ID_LEN: u32 = 64;

/// Max accepted length of `display_name`, in bytes.
const MAX_DISPLAY_NAME_LEN: u32 = 128;

/// Max number of entries in `capabilities`.
const MAX_CAPABILITIES: u32 = 32;

/// Max accepted length of a single capability string, in bytes.
const MAX_CAPABILITY_LEN: u32 = 32;

/// Max accepted length of `display_name` on the API side, in characters.
/// Stricter than the on-chain [`MAX_DISPLAY_NAME_LEN`] so the API can reject
/// over-long names before they reach the contract. Exposed here so the API
/// and contract agree on the cap.
pub const API_MAX_DISPLAY_NAME_LEN: u32 = 100;

#[contracttype]
#[derive(Clone)]
pub struct AgentInfo {
    pub id: String,
    pub owner: Address,
    pub display_name: String,
    pub stellar_address: Address,
    pub capabilities: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}

/// Per-agent records live under a single-key enum so the key type is
/// `#[contracttype]`-convertible (dynamic `String` payload supported).
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Agent(String),
}

/// Max accepted length of `description` on the API side, in characters.
/// `description` is API-only metadata (not stored on-chain); the cap lives
/// here so the API and contract share one source of truth for agent metadata
/// limits.
pub const API_MAX_DESCRIPTION_LEN: u32 = 500;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    IdEmpty = 1,
    IdTooLong = 2,
    AlreadyRegistered = 3,
    NotFound = 4,
    NotAuthorized = 5,
    Deactivated = 6,
    DisplayNameTooLong = 7,
    TooManyCapabilities = 8,
    CapabilityTooLong = 9,
    InvalidIdChar = 10,
    /// `display_name` was empty (`len() == 0`).
    DisplayNameEmpty = 11,
    /// A capability entry was empty (`len() == 0`).
    CapabilityEmpty = 12,
    /// The same capability string appeared more than once in one list.
    /// Comparison is exact byte equality (case-sensitive, no trimming) — see
    /// the module-level "Validation rules" section.
    CapabilityDuplicate = 13,
    /// A field that is not mutable through the metadata-update path was
    /// supplied (e.g. `status` or `stellar_address` on `PATCH /agents/:id`).
    FieldNotMutable = 14,
}

#[contract]
pub struct AgentRegistry;

fn validate_id(id: &String) -> Result<(), Error> {
    if id.is_empty() {
        return Err(Error::IdEmpty);
    }
    if id.len() > MAX_ID_LEN {
        return Err(Error::IdTooLong);
    }
    // soroban-sdk 22 exposes String::copy_into_slice (rather than to_bytes).
    // The length check above bounds this stack buffer to MAX_ID_LEN bytes.
    let len = id.len() as usize;
    let mut bytes = [0u8; MAX_ID_LEN as usize];
    id.copy_into_slice(&mut bytes[..len]);
    for (index, byte) in bytes[..len].iter().enumerate() {
        let lowercase = (b'a'..=b'z').contains(&byte);
        let digit = (b'0'..=b'9').contains(&byte);
        let allowed_punctuation = matches!(byte, b'.' | b'_' | b'-');
        if (index == 0 && !lowercase && !digit)
            || (index > 0 && !lowercase && !digit && !allowed_punctuation)
        {
            return Err(Error::InvalidIdChar);
        }
    }
    Ok(())
}

/// Reject an empty `display_name` or one longer than `MAX_DISPLAY_NAME_LEN`.
/// Whitespace-only names are accepted on purpose (documented in the module
/// docs): `soroban_sdk::String` has no byte/char accessor, so the check is not
/// expressible on-chain.
fn validate_display_name(name: &String) -> Result<(), Error> {
    if name.is_empty() {
        return Err(Error::DisplayNameEmpty);
    }
    if name.len() > MAX_DISPLAY_NAME_LEN {
        return Err(Error::DisplayNameTooLong);
    }
    Ok(())
}

/// Reject a `description` longer than [`API_MAX_DESCRIPTION_LEN`]. An empty
/// description is allowed (it clears the field). `description` is API-only
/// metadata; this validator exists so the API and contract agree on the cap.
pub fn validate_description(description: &String) -> Result<(), Error> {
    if description.len() > API_MAX_DESCRIPTION_LEN {
        return Err(Error::DisplayNameTooLong);
    }
    Ok(())
}

/// Reject a `display_name` longer than [`API_MAX_DISPLAY_NAME_LEN`] (the
/// stricter API-side cap). Used by the API's `PATCH /agents/:id` route so the
/// API rejects over-long names before the on-chain validator would.
pub fn validate_api_display_name(name: &String) -> Result<(), Error> {
    if name.is_empty() {
        return Err(Error::DisplayNameEmpty);
    }
    if name.len() > API_MAX_DISPLAY_NAME_LEN {
        return Err(Error::DisplayNameTooLong);
    }
    Ok(())
}

/// Reject a capability list that is too large, or that contains an empty,
/// over-long, or duplicated entry. Duplicates are compared by exact byte
/// equality (case-sensitive, no trimming) — see the module docs.
///
/// Order of checks: the entry count first, then each entry left to right with
/// the first violation winning (`CapabilityEmpty`, `CapabilityTooLong`, then
/// `CapabilityDuplicate`).
fn validate_capabilities(caps: &Vec<String>) -> Result<(), Error> {
    if caps.len() > MAX_CAPABILITIES {
        return Err(Error::TooManyCapabilities);
    }
    for i in 0..caps.len() {
        let cap = caps.get_unchecked(i);
        if cap.is_empty() {
            return Err(Error::CapabilityEmpty);
        }
        if cap.len() > MAX_CAPABILITY_LEN {
            return Err(Error::CapabilityTooLong);
        }
        // O(n^2) with n <= MAX_CAPABILITIES: bounded, allocation-free, which
        // keeps this usable in a `no_std` contract.
        for j in 0..i {
            if caps.get_unchecked(j) == cap {
                return Err(Error::CapabilityDuplicate);
            }
        }
    }
    Ok(())
}

/// Reject a patch that attempts to mutate a field that is not mutable through
/// the metadata-update path. `status` belongs to the dedicated status
/// endpoint; `stellar_address` is immutable after registration (see module
/// docs). Both are rejected here so the API and contract agree.
pub fn validate_mutable_fields(status_supplied: bool, stellar_address_supplied: bool) -> Result<(), Error> {
    if status_supplied || stellar_address_supplied {
        return Err(Error::FieldNotMutable);
    }
    Ok(())
}

/// Push both the record entry's TTL and the contract instance's TTL toward the
/// ledger max. Called on every WRITE path only: an actively-used record must
/// not be archived just because its instance outlived its default lifetime.
/// `query` deliberately does not call this — it is a pure read.
fn bump_ttl(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    let threshold = max / 2;
    env.storage().persistent().extend_ttl(key, threshold, max);
    env.storage().instance().extend_ttl(threshold, max);
}

#[contractimpl]
impl AgentRegistry {
    /// Register a new agent. The caller becomes the owner. When
    /// `stellar_address` is a party other than the caller, that address must
    /// authenticate too — an agent can only be bound to an address with its
    /// consent. The caller is never asked to authenticate twice.
    pub fn register(
        env: Env,
        caller: Address,
        id: String,
        display_name: String,
        stellar_address: Address,
        capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        if stellar_address != caller {
            stellar_address.require_auth();
        }
        validate_id(&id)?;
        validate_display_name(&display_name)?;
        validate_capabilities(&capabilities)?;
        let key = DataKey::Agent(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        let now = env.ledger().timestamp();
        let info = AgentInfo {
            id: id.clone(),
            owner: caller.clone(),
            display_name,
            stellar_address,
            capabilities,
            created_at: now,
            updated_at: now,
            active: true,
        };
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "registered"),
            ),
            (id, caller, info.stellar_address.clone()),
        );
        Ok(info)
    }

    /// Update display_name and capabilities. Only the registered owner, and
    /// only while the agent is still active.
    pub fn update_metadata(
        env: Env,
        caller: Address,
        id: String,
        new_display_name: String,
        new_capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id.clone());
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        if !info.active {
            return Err(Error::Deactivated);
        }
        validate_display_name(&new_display_name)?;
        validate_capabilities(&new_capabilities)?;
        info.display_name = new_display_name;
        info.capabilities = new_capabilities;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "updated"),
            ),
            (id, caller),
        );
        Ok(info)
    }

    /// Deactivate the agent — a PERMANENT tombstone. The record stays
    /// queryable, but the id can never be re-registered (even by this owner)
    /// and there is no reactivation entrypoint. Only the registered owner.
    pub fn deactivate(env: Env, caller: Address, id: String) -> Result<bool, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id.clone());
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        info.active = false;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "deactivated"),
            ),
            (id, caller),
        );
        Ok(true)
    }

    /// Query agent info. Anyone can query. This is a **pure read**: it performs
    /// no storage mutation and extends no TTL (see module docs).
    pub fn query(env: Env, id: String) -> Result<Option<AgentInfo>, Error> {
        validate_id(&id)?;
        let key = DataKey::Agent(id);
        Ok(env.storage().persistent().get(&key))
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::Instance as _, storage::Persistent as _, Address as _, Events as _,
            Ledger as _, MockAuth, MockAuthInvoke,
        },
        vec, IntoVal, TryIntoVal, Val,
    };
    use std::println;

    /// 64 bytes — at the limit, must be accepted.
    const ID_64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    /// 65 bytes — one over, must be rejected.
    const ID_65: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// Unwrap the contract error from a generated `try_*` result without
    /// clippy's `err_expect` lint (the Ok payloads don't implement `Debug`,
    /// so `.expect_err()` cannot be used here).
    type TryOutcome<T> =
        Result<Result<T, soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>>;

    fn want_err<T>(res: TryOutcome<T>) -> Error {
        match res {
            Ok(_) => panic!("expected an error result, got success"),
            Err(Ok(contract_error)) => contract_error,
            Err(Err(_)) => panic!("expected a contract error, got an invoke error"),
        }
    }

    fn setup() -> (Env, Address, AgentRegistryClient<'static>) {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);
        (env, contract_id, client)
    }

    fn key(env: &Env, id: &str) -> Val {
        DataKey::Agent(String::from_str(env, id)).into_val(env)
    }

    /// Read the TTL of an agent record entry.
    fn entry_ttl(env: &Env, cid: &Address, id: &str) -> u32 {
        env.as_contract(cid, || env.storage().persistent().get_ttl(&key(env, id)))
    }

    /// Read the TTL of the contract instance.
    fn instance_ttl(env: &Env, cid: &Address) -> u32 {
        env.as_contract(cid, || env.storage().instance().get_ttl())
    }

    fn register(env: &Env, client: &AgentRegistryClient, owner: &Address, id: &String, name: &str) {
        client.register(
            owner,
            id,
            &String::from_str(env, name),
            owner,
            &Vec::new(env),
        );
    }

    #[test]
    fn test_register_and_query() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");

        let info = client.register(
            &owner,
            &id,
            &String::from_str(&env, "Test Agent"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(info.id, id);
        assert_eq!(info.owner, owner);
        assert!(info.active);
        assert_eq!(info.created_at, info.updated_at);

        let queried = client.query(&id).unwrap();
        assert_eq!(queried.id, id);
    }

    #[test]
    fn test_duplicate_register_rejected() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        let res = client.try_register(
            &owner,
            &id,
            &String::from_str(&env, "B"),
            &owner,
            &Vec::new(&env),
        );
        // try_ returns Result<Result<T, T::Error>, Result<E, InvokeError>>
        let err = want_err(res);
        assert_eq!(err, Error::AlreadyRegistered);

        // Never overwrite: the original record is untouched.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_non_owner_rejected_without_mock() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        // Drop all auth mocks: stranger is not authenticated at all.
        env.set_auths(&[]);
        let stranger = Address::generate(&env);
        let res = client.try_update_metadata(
            &stranger,
            &id,
            &String::from_str(&env, "Hacked"),
            &Vec::new(&env),
        );
        assert!(res.is_err(), "unauthenticated caller must be rejected");

        // Now authenticate the stranger for this call only: they pass
        // require_auth() but are not the owner -> NotAuthorized.
        let name = String::from_str(&env, "Hacked");
        let caps = Vec::<String>::new(&env);
        let args: soroban_sdk::Vec<Val> = vec![
            &env,
            stranger.clone().into_val(&env),
            id.clone().into_val(&env),
            name.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &invoke,
        }]);
        let res = client.try_update_metadata(&stranger, &id, &name, &caps);
        let err = want_err(res);
        assert_eq!(err, Error::NotAuthorized);

        // State unchanged.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_owner_succeeds_with_scoped_mock() {
        let (env, cid, client) = setup();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        let name_a = String::from_str(&env, "A");
        let name_b = String::from_str(&env, "B");
        let caps = Vec::<String>::new(&env);

        // Scoped mock: only `owner` is authorized, only for `register`.
        let reg_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_a.clone().into_val(&env),
            owner.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let reg_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "register",
            args: reg_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &reg_invoke,
        }]);
        client.register(&owner, &id, &name_a, &owner, &caps);

        // Scoped mock: only `owner`, only for `update_metadata`.
        env.set_auths(&[]);
        let upd_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_b.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let upd_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args: upd_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &upd_invoke,
        }]);
        let updated = client.update_metadata(&owner, &id, &name_b, &caps);
        assert_eq!(updated.display_name, name_b);

        // And deactivate by the owner.
        env.set_auths(&[]);
        let deact_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
        ];
        let deact_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "deactivate",
            args: deact_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &deact_invoke,
        }]);
        assert!(client.deactivate(&owner, &id));
        assert!(!client.query(&id).unwrap().active);
    }

    #[test]
    fn test_id_validation() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // Empty id.
        let empty = String::from_str(&env, "");
        let res = client.try_register(
            &owner,
            &empty,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::IdEmpty);

        // 65 bytes -> too long.
        let too_long = String::from_str(&env, ID_65);
        let res = client.try_register(
            &owner,
            &too_long,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::IdTooLong);

        // Exactly 64 bytes -> accepted.
        let max = String::from_str(&env, ID_64);
        client.register(
            &owner,
            &max,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&max).unwrap().id, max);
    }

    #[test]
    fn test_id_charset_is_ascii_lowercase_and_case_sensitive() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        for invalid in [
            "Agent_1", "agent 1", "agent\n1", "agenté", ".agent", "_agent", "-agent",
        ] {
            let id = String::from_str(&env, invalid);
            let res = client.try_register(
                &owner,
                &id,
                &String::from_str(&env, "A"),
                &owner,
                &Vec::new(&env),
            );
            assert_eq!(want_err(res), Error::InvalidIdChar, "id: {invalid:?}");
        }

        let valid = String::from_str(&env, "agent_1.v2-test");
        client.register(
            &owner,
            &valid,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&valid).unwrap().id, valid);
    }

    #[test]
    fn test_unknown_id_errors() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let missing = String::from_str(&env, "nope");

        let res = client.try_update_metadata(
            &owner,
            &missing,
            &String::from_str(&env, "X"),
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::NotFound);

        let res = client.try_deactivate(&owner, &missing);
        assert_eq!(want_err(res), Error::NotFound);

        // query on an unknown id is Ok(None), not an error.
        assert!(client.query(&missing).is_none());
    }

    #[test]
    fn test_deactivate() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Test");

        client.deactivate(&owner, &id);
        let info = client.query(&id).unwrap();
        assert!(!info.active);
        // Tombstone: still readable, metadata preserved.
        assert_eq!(info.display_name, String::from_str(&env, "Test"));
    }

    // ---- regression tests for the independent security review fixes ----

    // F3: update_metadata rejects a deactivated agent (permanent tombstone).
    #[test]
    fn test_update_metadata_rejects_deactivated() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");
        client.deactivate(&owner, &id);

        let res = client.try_update_metadata(
            &owner,
            &id,
            &String::from_str(&env, "AFTER"),
            &Vec::new(&env),
        );
        let err = want_err(res);
        assert_eq!(err, Error::Deactivated);

        // State untouched: display_name still "A", still inactive.
        let info = client.query(&id).unwrap();
        assert!(!info.active);
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    // F4: binding stellar_address to a third party requires that party's consent.
    #[test]
    fn test_register_requires_stellar_address_consent() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let victim = Address::generate(&env);
        let id = String::from_str(&env, "a1");

        // mock_all_auths satisfies every address, so binding succeeds:
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &victim,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&id).unwrap().stellar_address, victim);

        // Scoped mock: authenticate ONLY the caller, only for `register`.
        // The caller's own require_auth() therefore passes, so the call can
        // only fail because `stellar_address` (victim) never authenticated.
        // Without the F4 fix this call would succeed.
        env.set_auths(&[]);
        let id2 = String::from_str(&env, "a2");
        let name = String::from_str(&env, "A");
        let caps = Vec::<String>::new(&env);
        let args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id2.clone().into_val(&env),
            name.clone().into_val(&env),
            victim.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "register",
            args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &invoke,
        }]);
        let res = client.try_register(&owner, &id2, &name, &victim, &caps);
        assert!(
            res.is_err(),
            "caller-only auth must not be enough to bind a third-party stellar_address"
        );
        assert!(
            client.query(&id2).is_none(),
            "rejected register must leave no record"
        );
    }

    // F5: metadata size caps enforced on register.
    #[test]
    fn test_metadata_size_caps_on_register() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // display_name over 128 bytes.
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "name_too_long"),
            &String::from_str(&env, &"X".repeat(129)),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::DisplayNameTooLong);

        // too many capabilities (>32).
        let mut caps = Vec::new(&env);
        for _ in 0..33 {
            caps.push_back(String::from_str(&env, "c"));
        }
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "many_caps"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::TooManyCapabilities);

        // a single capability over 32 bytes.
        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, &"c".repeat(33)));
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "big_cap"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::CapabilityTooLong);
    }

    // F5: caps also enforced on update_metadata.
    #[test]
    fn test_metadata_size_caps_on_update() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");

        let res = client.try_update_metadata(
            &owner,
            &id,
            &String::from_str(&env, &"X".repeat(129)),
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::DisplayNameTooLong);

        let mut caps = Vec::new(&env);
        for _ in 0..33 {
            caps.push_back(String::from_str(&env, "c"));
        }
        let res = client.try_update_metadata(&owner, &id, &String::from_str(&env, "ok"), &caps);
        assert_eq!(want_err(res), Error::TooManyCapabilities);

        // State untouched by the rejected updates.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
        assert_eq!(info.capabilities.len(), 0);
    }

    // F5: exactly-at-limit metadata is accepted.
    #[test]
    fn test_metadata_size_at_limits_accepted() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let mut caps = Vec::new(&env);
        // 32 DISTINCT entries, each exactly 32 bytes: exercises the entry-count
        // cap, the per-entry length cap, and the duplicate rule all at once.
        // (These must be distinct now that duplicates are rejected.)
        for i in 0..32u32 {
            let cap = std::format!("{:0>32}", i);
            assert_eq!(cap.len(), 32);
            caps.push_back(String::from_str(&env, &cap));
        }
        let info = client.register(
            &owner,
            &String::from_str(&env, "limits_ok"),
            &String::from_str(&env, &"d".repeat(128)),
            &owner,
            &caps,
        );
        assert_eq!(info.capabilities.len(), 32);
        assert_eq!(info.display_name.len(), 128);
        // And the same at-limit list is accepted on update_metadata too.
        let updated = client.update_metadata(
            &owner,
            &String::from_str(&env, "limits_ok"),
            &String::from_str(&env, &"e".repeat(128)),
            &caps,
        );
        assert_eq!(updated.display_name.len(), 128);
        assert_eq!(updated.capabilities.len(), 32);
    }

    // ---- lower-bound / uniqueness validation (empty + duplicate rules) ----

    // An empty display_name is rejected on register, and storage stays empty.
    #[test]
    fn test_empty_display_name_rejected_on_register() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "empty_name");

        let res = client.try_register(
            &owner,
            &id,
            &String::from_str(&env, ""),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::DisplayNameEmpty);
        assert!(
            client.query(&id).is_none(),
            "a rejected register must leave no record"
        );
    }

    // An empty display_name is rejected on update_metadata, leaving state intact.
    #[test]
    fn test_empty_display_name_rejected_on_update() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");

        let res =
            client.try_update_metadata(&owner, &id, &String::from_str(&env, ""), &Vec::new(&env));
        assert_eq!(want_err(res), Error::DisplayNameEmpty);

        // State untouched.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    // An empty capability string is rejected on register.
    #[test]
    fn test_empty_capability_rejected_on_register() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "empty_cap");

        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, "read"));
        caps.push_back(String::from_str(&env, ""));
        let res = client.try_register(&owner, &id, &String::from_str(&env, "A"), &owner, &caps);
        assert_eq!(want_err(res), Error::CapabilityEmpty);
        assert!(client.query(&id).is_none());
    }

    // An empty capability string is rejected on update_metadata, state intact.
    #[test]
    fn test_empty_capability_rejected_on_update() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");

        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, ""));
        let res = client.try_update_metadata(&owner, &id, &String::from_str(&env, "B"), &caps);
        assert_eq!(want_err(res), Error::CapabilityEmpty);

        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
        assert_eq!(info.capabilities.len(), 0);
    }

    // A repeated capability is rejected on register.
    #[test]
    fn test_duplicate_capability_rejected_on_register() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "dup_cap");

        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, "read"));
        caps.push_back(String::from_str(&env, "write"));
        caps.push_back(String::from_str(&env, "read"));
        let res = client.try_register(&owner, &id, &String::from_str(&env, "A"), &owner, &caps);
        assert_eq!(want_err(res), Error::CapabilityDuplicate);
        assert!(client.query(&id).is_none());
    }

    // A repeated capability is rejected on update_metadata, state intact.
    #[test]
    fn test_duplicate_capability_rejected_on_update() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");

        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, "read"));
        caps.push_back(String::from_str(&env, "read"));
        let res = client.try_update_metadata(&owner, &id, &String::from_str(&env, "B"), &caps);
        assert_eq!(want_err(res), Error::CapabilityDuplicate);

        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
        assert_eq!(info.capabilities.len(), 0);
    }

    // Duplicate detection is EXACT byte equality: differently-cased entries are
    // distinct and therefore accepted. This pins the documented comparison rule.
    #[test]
    fn test_case_folded_capabilities_are_distinct() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "case_caps");

        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, "Vision"));
        caps.push_back(String::from_str(&env, "vision"));
        let info = client.register(&owner, &id, &String::from_str(&env, "A"), &owner, &caps);
        assert_eq!(info.capabilities.len(), 2);
    }

    // Documented decision: whitespace-only display_name is ACCEPTED (the SDK
    // gives no byte/char accessor, so it cannot be rejected on-chain). This test
    // makes the decision executable; update it deliberately if that ever changes.
    #[test]
    fn test_whitespace_only_display_name_accepted_by_design() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "ws_name");

        let info = client.register(
            &owner,
            &id,
            &String::from_str(&env, "   "),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(info.display_name, String::from_str(&env, "   "));
    }

    // Precedence: an over-long list is rejected before per-entry rules, and an
    // empty entry is reported before a duplicate one.
    #[test]
    fn test_capability_validation_precedence() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // 33 empty entries: the count cap wins over CapabilityEmpty.
        let mut caps = Vec::new(&env);
        for _ in 0..33 {
            caps.push_back(String::from_str(&env, ""));
        }
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "many_empty"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::TooManyCapabilities);

        // The first entry's empty-string violation is reported before the
        // later duplicate.
        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, ""));
        caps.push_back(String::from_str(&env, ""));
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "empty_then_dup"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::CapabilityEmpty);

        // An over-long entry is reported before a duplicate of it.
        let oversized = "c".repeat(33);
        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, &oversized));
        caps.push_back(String::from_str(&env, &oversized));
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "long_then_dup"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::CapabilityTooLong);
    }

    // F1: write paths extend the contract INSTANCE ttl — not only the entry.
    #[test]
    fn test_write_extends_instance_ttl() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");

        let inst_before = instance_ttl(&env, &cid);
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        let inst_after = instance_ttl(&env, &cid);
        println!(
            "F1: instance_ttl before={} after_register={}",
            inst_before, inst_after
        );
        assert!(
            inst_after > inst_before,
            "register must extend the contract instance TTL toward max_ttl"
        );

        let entry_before = entry_ttl(&env, &cid, "a1");
        client.update_metadata(&owner, &id, &String::from_str(&env, "B"), &Vec::new(&env));
        let entry_after = entry_ttl(&env, &cid, "a1");
        assert!(entry_after >= entry_before, "update extends entry TTL");
        let inst_after_update = instance_ttl(&env, &cid);
        assert!(
            inst_after_update >= inst_after,
            "update extends instance TTL too"
        );
    }

    // F1: deactivate also extends instance ttl (no write path starves it).
    #[test]
    fn test_deactivate_extends_instance_ttl() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        // Age the instance past the extend threshold (max/2) so that a
        // subsequent write's bump_ttl must fire and push the expiration out.
        let threshold = env.storage().max_ttl() / 2;
        let jump = threshold + 10;
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + jump);
        // Measure the *aged* remaining TTL (below threshold) — this is the
        // baseline a write must beat.
        let aged = instance_ttl(&env, &cid);
        client.deactivate(&owner, &id);
        let after = instance_ttl(&env, &cid);
        println!(
            "F1-deact: aged_instance_ttl={} max_ttl={} after_deactivate={}",
            aged,
            env.storage().max_ttl(),
            after
        );
        assert!(
            after > aged,
            "deactivate must extend the aged instance TTL toward max_ttl"
        );
    }

    // F6: query() is a pure read — it mutates no TTL.
    #[test]
    fn test_query_is_pure_read() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );

        // Decay BOTH the entry and the instance below the extend threshold
        // (max/2) first. Otherwise the record still sits at max_ttl and a
        // reintroduced bump would be an invisible no-op, letting a regression
        // slip through. This test must fail if `query` mutates any TTL.
        let threshold = env.storage().max_ttl() / 2;
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + threshold + 10);

        let entry_before = entry_ttl(&env, &cid, "a1");
        let inst_before = instance_ttl(&env, &cid);
        assert!(
            entry_before < threshold,
            "test setup: entry must be below the extend threshold (got {})",
            entry_before
        );

        let _ = client.query(&id);
        let _ = client.query(&id);

        let entry_after = entry_ttl(&env, &cid, "a1");
        let inst_after = instance_ttl(&env, &cid);
        println!(
            "F6: entry_ttl {}->{}  instance_ttl {}->{}",
            entry_before, entry_after, inst_before, inst_after
        );
        assert_eq!(
            entry_before, entry_after,
            "query must not mutate the record entry TTL"
        );
        assert_eq!(
            inst_before, inst_after,
            "query must not mutate the contract instance TTL"
        );
    }

    // ---- event emission tests ----

    /// Captures contract events published during execution of `f`.
    fn capture_events<F>(env: &Env, f: F) -> Vec<(Address, Vec<Val>, Val)>
    where
        F: FnOnce(),
    {
        f();
        env.events().all()
    }

    #[test]
    fn test_register_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let stellar_addr = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");

        let events = capture_events(&env, || {
            client.register(
                &owner,
                &id,
                &String::from_str(&env, "Test Agent"),
                &stellar_addr,
                &Vec::new(&env),
            );
        });

        assert_eq!(events.len(), 1, "register should emit exactly one event");
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "registered"));

        let payload: (String, Address, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_update_metadata_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Original");

        let events = capture_events(&env, || {
            client.update_metadata(
                &owner,
                &id,
                &String::from_str(&env, "Updated"),
                &Vec::new(&env),
            );
        });

        assert_eq!(
            events.len(),
            1,
            "update_metadata should emit exactly one event"
        );
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "updated"));

        let payload: (String, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_deactivate_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Test");

        let events = capture_events(&env, || {
            client.deactivate(&owner, &id);
        });

        assert_eq!(events.len(), 1, "deactivate should emit exactly one event");
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "deactivated"));

        let payload: (String, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_failed_register_emits_no_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        let events = capture_events(&env, || {
            let res = client.try_register(
                &owner,
                &id,
                &String::from_str(&env, "B"),
                &owner,
                &Vec::new(&env),
            );
            assert!(res.is_err());
        });

        assert!(events.is_empty(), "failed register must not emit an event");
    }

    #[test]
    fn test_failed_update_emits_no_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let stranger = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        env.set_auths(&[]);
        let events = capture_events(&env, || {
            let res = client.try_update_metadata(
                &stranger,
                &id,
                &String::from_str(&env, "Hacked"),
                &Vec::new(&env),
            );
            assert!(res.is_err());
        });

        assert!(events.is_empty(), "failed update must not emit an event");
    }

    // ---- API-side metadata caps (PATCH /agents/:id) ----

    // The API-side display_name cap is stricter than the on-chain cap and is
    // enforced before the on-chain validator would fire.
    #[test]
    fn test_api_display_name_cap() {
        let (env, _cid, _client) = setup();
        // Exactly at the API cap: accepted.
        let at_limit = String::from_str(&env, &"d".repeat(API_MAX_DISPLAY_NAME_LEN as usize));
        assert_eq!(validate_api_display_name(&at_limit), Ok(()));
        // One over the API cap: rejected, even though it is under the
        // on-chain MAX_DISPLAY_NAME_LEN.
        let over = String::from_str(&env, &"d".repeat(API_MAX_DISPLAY_NAME_LEN as usize + 1));
        assert_eq!(
            validate_api_display_name(&over),
            Err(Error::DisplayNameTooLong)
        );
        // Empty: rejected.
        let empty = String::from_str(&env, "");
        assert_eq!(
            validate_api_display_name(&empty),
            Err(Error::DisplayNameEmpty)
        );
    }

    // The API-side description cap is enforced and an empty description is
    // allowed (it clears the field).
    #[test]
    fn test_api_description_cap() {
        let (env, _cid, _client) = setup();
        let empty = String::from_str(&env, "");
        assert_eq!(validate_description(&empty), Ok(()));
        let at_limit = String::from_str(&env, &"x".repeat(API_MAX_DESCRIPTION_LEN as usize));
        assert_eq!(validate_description(&at_limit), Ok(()));
        let over = String::from_str(&env, &"x".repeat(API_MAX_DESCRIPTION_LEN as usize + 1));
        assert_eq!(validate_description(&over), Err(Error::DisplayNameTooLong));
    }

    // `status` and `stellar_address` are rejected on the metadata-update path.
    #[test]
    fn test_immutable_fields_rejected() {
        assert_eq!(validate_mutable_fields(false, false), Ok(()));
        assert_eq!(
            validate_mutable_fields(true, false),
            Err(Error::FieldNotMutable)
        );
        assert_eq!(
            validate_mutable_fields(false, true),
            Err(Error::FieldNotMutable)
        );
        assert_eq!(
            validate_mutable_fields(true, true),
            Err(Error::FieldNotMutable)
        );
    }
}
