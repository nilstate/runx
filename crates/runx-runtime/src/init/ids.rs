#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) use crate::time::now_iso8601;

pub(crate) fn random_uuid_v4() -> String {
    let mut bytes = random_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn random_bytes() -> [u8; 16] {
    #[cfg(unix)]
    {
        let mut bytes = [0_u8; 16];
        if fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut bytes))
            .is_ok()
        {
            return bytes;
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0_u128, |duration| duration.as_nanos());
    let process = u128::from(std::process::id());
    let mixed = now ^ process.rotate_left(17);
    mixed.to_le_bytes()
}
