use std::fmt;

use crate::MediaProcessingError;

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
pub struct FourCc(pub [u8; 4]);

impl FourCc {
    pub const fn new(value: [u8; 4]) -> Self {
        Self(value)
    }

    pub fn as_bytes(self) -> [u8; 4] {
        self.0
    }

    pub fn as_str_lossy(self) -> String {
        String::from_utf8_lossy(&self.0).into_owned()
    }
}

impl fmt::Debug for FourCc {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_str_lossy())
    }
}

impl fmt::Display for FourCc {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.as_str_lossy())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Mp4Box<'a> {
    pub kind: FourCc,
    pub offset: usize,
    pub size: usize,
    pub header_size: usize,
    pub payload: &'a [u8],
}

pub fn parse_boxes(data: &[u8]) -> Result<Vec<Mp4Box<'_>>, MediaProcessingError> {
    let mut result = Vec::new();
    let mut cursor = 0_usize;

    while cursor < data.len() {
        let remaining = data.len() - cursor;
        if remaining < 8 {
            if data[cursor..].iter().all(|byte| *byte == 0) {
                break;
            }
            return Err(demux_error("truncated ISO-BMFF box header"));
        }

        let size32 = read_u32(&data[cursor..cursor + 4])? as u64;
        let kind = FourCc::new(
            data[cursor + 4..cursor + 8]
                .try_into()
                .map_err(|_| demux_error("invalid ISO-BMFF fourcc"))?,
        );

        let (box_size_u64, header_size) = match size32 {
            0 => ((data.len() - cursor) as u64, 8_usize),
            1 => {
                if remaining < 16 {
                    return Err(demux_error("truncated ISO-BMFF extended-size header"));
                }
                (read_u64(&data[cursor + 8..cursor + 16])?, 16_usize)
            }
            value => (value, 8_usize),
        };

        if box_size_u64 < header_size as u64 {
            return Err(demux_error(format!(
                "invalid ISO-BMFF box size {box_size_u64} for {kind}"
            )));
        }
        let box_size = usize::try_from(box_size_u64)
            .map_err(|_| demux_error("ISO-BMFF box size does not fit this platform"))?;
        let end = cursor
            .checked_add(box_size)
            .ok_or_else(|| demux_error("ISO-BMFF box offset overflow"))?;
        if end > data.len() {
            return Err(demux_error(format!(
                "ISO-BMFF box {kind} extends past its parent"
            )));
        }

        result.push(Mp4Box {
            kind,
            offset: cursor,
            size: box_size,
            header_size,
            payload: &data[cursor + header_size..end],
        });

        if box_size == 0 {
            break;
        }
        cursor = end;
    }

    Ok(result)
}

pub fn child<'a>(
    boxes: &'a [Mp4Box<'a>],
    kind: [u8; 4],
) -> Option<&'a Mp4Box<'a>> {
    boxes.iter().find(|item| item.kind == FourCc::new(kind))
}

pub fn full_box_body(data: &[u8]) -> Result<(u8, u32, &[u8]), MediaProcessingError> {
    if data.len() < 4 {
        return Err(demux_error("truncated ISO-BMFF full-box header"));
    }
    let version = data[0];
    let flags = u32::from_be_bytes([0, data[1], data[2], data[3]]);
    Ok((version, flags, &data[4..]))
}

pub fn read_u16(data: &[u8]) -> Result<u16, MediaProcessingError> {
    let bytes: [u8; 2] = data
        .get(..2)
        .ok_or_else(|| demux_error("truncated u16 field"))?
        .try_into()
        .map_err(|_| demux_error("invalid u16 field"))?;
    Ok(u16::from_be_bytes(bytes))
}

pub fn read_u32(data: &[u8]) -> Result<u32, MediaProcessingError> {
    let bytes: [u8; 4] = data
        .get(..4)
        .ok_or_else(|| demux_error("truncated u32 field"))?
        .try_into()
        .map_err(|_| demux_error("invalid u32 field"))?;
    Ok(u32::from_be_bytes(bytes))
}

pub fn read_i32(data: &[u8]) -> Result<i32, MediaProcessingError> {
    let bytes: [u8; 4] = data
        .get(..4)
        .ok_or_else(|| demux_error("truncated i32 field"))?
        .try_into()
        .map_err(|_| demux_error("invalid i32 field"))?;
    Ok(i32::from_be_bytes(bytes))
}

pub fn read_u64(data: &[u8]) -> Result<u64, MediaProcessingError> {
    let bytes: [u8; 8] = data
        .get(..8)
        .ok_or_else(|| demux_error("truncated u64 field"))?
        .try_into()
        .map_err(|_| demux_error("invalid u64 field"))?;
    Ok(u64::from_be_bytes(bytes))
}

pub fn slice(
    data: &[u8],
    start: usize,
    length: usize,
) -> Result<&[u8], MediaProcessingError> {
    let end = start
        .checked_add(length)
        .ok_or_else(|| demux_error("ISO-BMFF field range overflow"))?;
    data.get(start..end)
        .ok_or_else(|| demux_error("truncated ISO-BMFF field"))
}

pub fn demux_error(message: impl Into<String>) -> MediaProcessingError {
    MediaProcessingError::Demux(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_regular_and_extended_boxes() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&12_u32.to_be_bytes());
        bytes.extend_from_slice(b"free");
        bytes.extend_from_slice(b"ABCD");
        bytes.extend_from_slice(&1_u32.to_be_bytes());
        bytes.extend_from_slice(b"wide");
        bytes.extend_from_slice(&20_u64.to_be_bytes());
        bytes.extend_from_slice(b"WXYZ");

        let boxes = parse_boxes(&bytes).expect("boxes");
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0].kind, FourCc::new(*b"free"));
        assert_eq!(boxes[0].payload, b"ABCD");
        assert_eq!(boxes[1].kind, FourCc::new(*b"wide"));
        assert_eq!(boxes[1].header_size, 16);
        assert_eq!(boxes[1].payload, b"WXYZ");
    }

    #[test]
    fn rejects_box_extending_past_parent() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&99_u32.to_be_bytes());
        bytes.extend_from_slice(b"moov");
        assert!(parse_boxes(&bytes).is_err());
    }
}
