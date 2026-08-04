use std::io::{BufReader, Read};
use std::sync::mpsc;

use runx_contracts::javascript_worker::{
    MAX_FRAME_BYTES, PROTOCOL_VERSION, WorkerResponse, read_frame,
};
use serde_json::Value;

pub(super) type WorkerFrameResult = Result<WorkerResponse, String>;

pub(super) fn read_responses(stdout: impl Read, responses: mpsc::Sender<WorkerFrameResult>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_frame::<Value>(&mut reader, MAX_FRAME_BYTES) {
            Ok(Some(frame)) => {
                let actual_protocol = frame.get("protocol_version").and_then(Value::as_u64);
                if actual_protocol != Some(u64::from(PROTOCOL_VERSION)) {
                    let actual = actual_protocol
                        .map_or_else(|| "missing".to_owned(), |value| value.to_string());
                    let _ignored = responses.send(Err(format!(
                        "deterministic JavaScript worker protocol version mismatch: expected {PROTOCOL_VERSION}, got {actual}"
                    )));
                    return;
                }
                let response = match serde_json::from_value::<WorkerResponse>(frame) {
                    Ok(response) => response,
                    Err(error) => {
                        let _ignored = responses.send(Err(format!(
                            "deterministic JavaScript worker protocol failed: {error}"
                        )));
                        return;
                    }
                };
                if responses.send(Ok(response)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                let _ignored = responses.send(Err(
                    "deterministic JavaScript worker exited without completing its invocation"
                        .to_owned(),
                ));
                return;
            }
            Err(error) => {
                let _ignored = responses.send(Err(format!(
                    "deterministic JavaScript worker protocol failed: {error}"
                )));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::mpsc;

    use runx_contracts::javascript_worker::{MAX_FRAME_BYTES, PROTOCOL_VERSION, write_frame};
    use serde_json::json;

    use super::read_responses;

    #[test]
    fn rejects_a_stale_worker_before_decoding_its_response_shape()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut frame = Vec::new();
        write_frame(
            &mut frame,
            &json!({
                "type": "failure",
                "protocol_version": PROTOCOL_VERSION - 1,
                "invocation_id": null,
                "code": "invalid_protocol",
                "message": "old worker",
                "discard_worker": true
            }),
            MAX_FRAME_BYTES,
        )?;
        let (sender, receiver) = mpsc::channel();

        read_responses(Cursor::new(frame), sender);

        let error = receiver
            .recv()?
            .err()
            .ok_or("stale worker response did not fail")?;
        assert!(error.contains("protocol version mismatch"));
        assert!(error.contains(&format!("expected {PROTOCOL_VERSION}")));
        Ok(())
    }
}
