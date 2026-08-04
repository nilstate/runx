use runx_pay::{
    PaymentChargePolicy, PaymentCredentialReference, PaymentRefundRequest, PaymentSignal,
    PaymentToolCall,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

#[test]
fn payment_contracts_enforce_domain_boundaries() {
    accepts::<PaymentSignal>(json!({
        "amount_minor": 125,
        "currency": "USD",
        "counterparty": "merchant:demo",
        "operation": "search.paid",
        "provider_extension": { "network": "test" },
    }));
    rejects::<PaymentSignal>(json!({
        "amount_minor": 0,
        "currency": "usd",
        "counterparty": "merchant:demo",
        "operation": "search.paid",
    }));

    accepts::<PaymentToolCall>(json!({ "tool": "search.paid", "arguments": {} }));
    rejects::<PaymentToolCall>(json!({ "tool": "search.paid", "arguments": {}, "server": "demo" }));

    accepts::<PaymentChargePolicy>(json!({
        "price_minor": 125,
        "currency": "USD",
        "accepted_settlement_families": ["mock"],
        "counterparty": "provider:demo",
    }));
    rejects::<PaymentChargePolicy>(json!({
        "price_minor": 125,
        "currency": "USD",
        "accepted_settlement_families": "mock",
        "counterparty": "provider:demo",
    }));

    accepts::<PaymentCredentialReference>(
        json!({ "family": "mock", "credential_ref": "credential:mock:1" }),
    );
    rejects::<PaymentCredentialReference>(
        json!({ "family": "mock", "credential_ref": "credential:mock:1", "token": "secret" }),
    );

    accepts::<PaymentRefundRequest>(json!({ "amount_minor": 125, "reason": "duplicate" }));
    rejects::<PaymentRefundRequest>(
        json!({ "amount_minor": 125, "reason": "duplicate", "provider": "stripe" }),
    );
}

fn accepts<T: DeserializeOwned>(value: Value) {
    serde_json::from_value::<T>(value).expect("valid payment contract");
}

fn rejects<T: DeserializeOwned>(value: Value) {
    assert!(serde_json::from_value::<T>(value).is_err());
}
