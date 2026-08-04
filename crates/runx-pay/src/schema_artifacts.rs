//! Schema artifacts contributed by the payment contract owner.

use runx_contracts::{SchemaArtifact, public_packet_artifact};

use crate::contracts::{
    PaymentChargeChallengePacket, PaymentChargePlan, PaymentChargePolicy, PaymentChargePricePacket,
    PaymentChargeVerificationRequest, PaymentCredentialReference, PaymentInvoiceSettlementPlan,
    PaymentQuotePacket, PaymentRefundPlan, PaymentRefundRequest, PaymentReservationPacket,
    PaymentSignal, PaymentToolCall,
};

#[must_use]
pub fn generated_payment_schema_artifacts() -> Vec<SchemaArtifact> {
    vec![
        public_packet_artifact::<PaymentSignal>("payment-signal.schema.json"),
        public_packet_artifact::<PaymentToolCall>("payment-tool-call.schema.json"),
        public_packet_artifact::<PaymentChargePolicy>("payment-charge-policy.schema.json"),
        public_packet_artifact::<PaymentCredentialReference>(
            "payment-credential-reference.schema.json",
        ),
        public_packet_artifact::<PaymentRefundRequest>("payment-refund-request.schema.json"),
        public_packet_artifact::<PaymentChargePricePacket>("payment-charge-price.schema.json"),
        public_packet_artifact::<PaymentChargeChallengePacket>(
            "payment-charge-challenge.schema.json",
        ),
        public_packet_artifact::<PaymentChargeVerificationRequest>(
            "payment-charge-verification-request.schema.json",
        ),
        public_packet_artifact::<PaymentChargePlan>("payment-charge-plan.schema.json"),
        public_packet_artifact::<PaymentQuotePacket>("payment-quote.schema.json"),
        public_packet_artifact::<PaymentReservationPacket>("payment-reservation.schema.json"),
        public_packet_artifact::<PaymentInvoiceSettlementPlan>(
            "payment-invoice-settlement-plan.schema.json",
        ),
        public_packet_artifact::<PaymentRefundPlan>("payment-refund-plan.schema.json"),
    ]
}
