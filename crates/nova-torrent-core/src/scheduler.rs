pub const DEFAULT_BLOCK_SIZE: u32 = 16 * 1024;
pub const MAX_BLOCK_SIZE: u32 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PieceLayout {
    total_length: u64,
    piece_length: u32,
    piece_count: u32,
}

impl PieceLayout {
    pub fn new(total_length: u64, piece_length: u64) -> Result<Self, SchedulerError> {
        if total_length == 0 {
            return Err(SchedulerError::EmptyPayload);
        }
        if piece_length == 0 || piece_length > u64::from(u32::MAX) {
            return Err(SchedulerError::InvalidPieceLength(piece_length));
        }
        let piece_count = total_length
            .checked_add(piece_length - 1)
            .ok_or(SchedulerError::LengthOverflow)?
            / piece_length;
        let piece_count =
            u32::try_from(piece_count).map_err(|_| SchedulerError::TooManyPieces(piece_count))?;
        Ok(Self {
            total_length,
            piece_length: piece_length as u32,
            piece_count,
        })
    }

    pub const fn total_length(self) -> u64 {
        self.total_length
    }

    pub const fn piece_length(self) -> u32 {
        self.piece_length
    }

    pub const fn piece_count(self) -> u32 {
        self.piece_count
    }

    pub fn piece_size(self, piece_index: u32) -> Result<u32, SchedulerError> {
        if piece_index >= self.piece_count {
            return Err(SchedulerError::PieceOutOfRange {
                piece_index,
                piece_count: self.piece_count,
            });
        }
        let start = u64::from(piece_index) * u64::from(self.piece_length);
        let remaining = self.total_length - start;
        Ok(remaining.min(u64::from(self.piece_length)) as u32)
    }

    pub fn block_requests(
        self,
        piece_index: u32,
        block_size: u32,
    ) -> Result<Vec<BlockRequest>, SchedulerError> {
        if block_size == 0 || block_size > MAX_BLOCK_SIZE {
            return Err(SchedulerError::InvalidBlockSize(block_size));
        }
        let piece_size = self.piece_size(piece_index)?;
        let mut requests = Vec::new();
        let mut begin = 0u32;
        while begin < piece_size {
            let length = block_size.min(piece_size - begin);
            requests.push(BlockRequest {
                piece_index,
                begin,
                length,
            });
            begin = begin
                .checked_add(length)
                .ok_or(SchedulerError::LengthOverflow)?;
        }
        Ok(requests)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BlockRequest {
    pub piece_index: u32,
    pub begin: u32,
    pub length: u32,
}

#[derive(Clone, Debug)]
pub struct PieceScheduler {
    layout: PieceLayout,
    availability: Vec<u32>,
    completed: Vec<bool>,
    inflight: Vec<bool>,
    cursor: usize,
}

impl PieceScheduler {
    pub fn new(layout: PieceLayout) -> Self {
        let count = layout.piece_count as usize;
        Self {
            layout,
            availability: vec![0; count],
            completed: vec![false; count],
            inflight: vec![false; count],
            cursor: 0,
        }
    }

    pub const fn layout(&self) -> PieceLayout {
        self.layout
    }

    pub fn peer_connected(&mut self, bitfield: &[u8]) -> Result<(), SchedulerError> {
        self.adjust_availability(bitfield, true)
    }

    pub fn peer_disconnected(&mut self, bitfield: &[u8]) -> Result<(), SchedulerError> {
        self.adjust_availability(bitfield, false)
    }

    pub fn availability(&self, piece_index: u32) -> Result<u32, SchedulerError> {
        self.validate_piece(piece_index)?;
        Ok(self.availability[piece_index as usize])
    }

    /// Select the rarest piece advertised by this peer.
    ///
    /// Completed and already-inflight pieces are skipped. Equal-rarity pieces
    /// are rotated from an internal cursor to avoid permanently preferring low
    /// indexes across repeated peer assignments.
    pub fn select_rarest(&mut self, peer_bitfield: &[u8]) -> Option<u32> {
        let count = self.layout.piece_count as usize;
        if count == 0 {
            return None;
        }

        let mut best: Option<(u32, usize, usize)> = None;
        for index in 0..count {
            if self.completed[index]
                || self.inflight[index]
                || !bit_is_set(peer_bitfield, index)
                || self.availability[index] == 0
            {
                continue;
            }
            let distance = (index + count - self.cursor) % count;
            let candidate = (self.availability[index], distance, index);
            if best.map_or(true, |current| candidate < current) {
                best = Some(candidate);
            }
        }

        let (_, _, index) = best?;
        self.inflight[index] = true;
        self.cursor = (index + 1) % count;
        Some(index as u32)
    }

    pub fn mark_inflight(&mut self, piece_index: u32) -> Result<(), SchedulerError> {
        self.validate_piece(piece_index)?;
        let index = piece_index as usize;
        if self.completed[index] {
            return Err(SchedulerError::PieceAlreadyComplete(piece_index));
        }
        self.inflight[index] = true;
        Ok(())
    }

    pub fn release(&mut self, piece_index: u32) -> Result<(), SchedulerError> {
        self.validate_piece(piece_index)?;
        self.inflight[piece_index as usize] = false;
        Ok(())
    }

    pub fn mark_complete(&mut self, piece_index: u32) -> Result<(), SchedulerError> {
        self.validate_piece(piece_index)?;
        let index = piece_index as usize;
        self.completed[index] = true;
        self.inflight[index] = false;
        Ok(())
    }

    pub fn mark_incomplete(&mut self, piece_index: u32) -> Result<(), SchedulerError> {
        self.validate_piece(piece_index)?;
        let index = piece_index as usize;
        self.completed[index] = false;
        self.inflight[index] = false;
        Ok(())
    }

    pub fn is_complete(&self) -> bool {
        self.completed.iter().all(|complete| *complete)
    }

    pub fn completed_piece_count(&self) -> u32 {
        self.completed.iter().filter(|complete| **complete).count() as u32
    }

    pub fn completed_bytes(&self) -> u64 {
        self.completed
            .iter()
            .enumerate()
            .filter_map(|(index, complete)| {
                complete
                    .then(|| self.layout.piece_size(index as u32).ok())
                    .flatten()
            })
            .map(u64::from)
            .sum()
    }

    fn adjust_availability(
        &mut self,
        bitfield: &[u8],
        connected: bool,
    ) -> Result<(), SchedulerError> {
        for index in 0..self.availability.len() {
            if !bit_is_set(bitfield, index) {
                continue;
            }
            let count = &mut self.availability[index];
            if connected {
                *count = count
                    .checked_add(1)
                    .ok_or(SchedulerError::AvailabilityOverflow(index as u32))?;
            } else if *count == 0 {
                return Err(SchedulerError::AvailabilityUnderflow(index as u32));
            } else {
                *count -= 1;
            }
        }
        Ok(())
    }

    fn validate_piece(&self, piece_index: u32) -> Result<(), SchedulerError> {
        if piece_index >= self.layout.piece_count {
            return Err(SchedulerError::PieceOutOfRange {
                piece_index,
                piece_count: self.layout.piece_count,
            });
        }
        Ok(())
    }
}

fn bit_is_set(bitfield: &[u8], piece_index: usize) -> bool {
    let byte_index = piece_index / 8;
    let bit_index = piece_index % 8;
    bitfield
        .get(byte_index)
        .is_some_and(|byte| byte & (0x80 >> bit_index) != 0)
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum SchedulerError {
    #[error("torrent payload cannot be empty")]
    EmptyPayload,
    #[error("invalid torrent piece length: {0}")]
    InvalidPieceLength(u64),
    #[error("invalid torrent block size: {0}")]
    InvalidBlockSize(u32),
    #[error("torrent length arithmetic overflow")]
    LengthOverflow,
    #[error("torrent has too many pieces for peer protocol: {0}")]
    TooManyPieces(u64),
    #[error("piece {piece_index} is outside piece count {piece_count}")]
    PieceOutOfRange {
        piece_index: u32,
        piece_count: u32,
    },
    #[error("piece {0} is already complete")]
    PieceAlreadyComplete(u32),
    #[error("piece availability overflow for piece {0}")]
    AvailabilityOverflow(u32),
    #[error("piece availability underflow for piece {0}")]
    AvailabilityUnderflow(u32),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_sizes_last_piece_and_splits_blocks() {
        let layout = PieceLayout::new(40_000, 32_768).expect("layout");
        assert_eq!(layout.piece_count(), 2);
        assert_eq!(layout.piece_size(0), Ok(32_768));
        assert_eq!(layout.piece_size(1), Ok(7_232));
        assert_eq!(
            layout.block_requests(0, DEFAULT_BLOCK_SIZE).expect("blocks"),
            vec![
                BlockRequest {
                    piece_index: 0,
                    begin: 0,
                    length: 16_384,
                },
                BlockRequest {
                    piece_index: 0,
                    begin: 16_384,
                    length: 16_384,
                },
            ]
        );
    }

    #[test]
    fn scheduler_uses_rarest_first_and_skips_inflight() {
        let layout = PieceLayout::new(4, 1).expect("layout");
        let mut scheduler = PieceScheduler::new(layout);

        // Peer A has 0,1,2. Peer B has 1,2,3. Pieces 0 and 3 are rarest.
        scheduler.peer_connected(&[0b1110_0000]).expect("peer a");
        scheduler.peer_connected(&[0b0111_0000]).expect("peer b");

        assert_eq!(scheduler.availability(0), Ok(1));
        assert_eq!(scheduler.availability(1), Ok(2));
        assert_eq!(scheduler.availability(2), Ok(2));
        assert_eq!(scheduler.availability(3), Ok(1));

        assert_eq!(scheduler.select_rarest(&[0b1110_0000]), Some(0));
        // Piece 0 is now inflight, so the same peer receives one of its
        // availability=2 pieces rather than duplicating work.
        assert_eq!(scheduler.select_rarest(&[0b1110_0000]), Some(1));
    }

    #[test]
    fn completion_tracks_exact_payload_bytes() {
        let layout = PieceLayout::new(5, 4).expect("layout");
        let mut scheduler = PieceScheduler::new(layout);
        scheduler.mark_complete(1).expect("last piece");
        assert_eq!(scheduler.completed_piece_count(), 1);
        assert_eq!(scheduler.completed_bytes(), 1);
        assert!(!scheduler.is_complete());
        scheduler.mark_complete(0).expect("first piece");
        assert_eq!(scheduler.completed_bytes(), 5);
        assert!(scheduler.is_complete());
    }

    #[test]
    fn disconnect_cannot_underflow_availability() {
        let layout = PieceLayout::new(1, 1).expect("layout");
        let mut scheduler = PieceScheduler::new(layout);
        assert_eq!(
            scheduler.peer_disconnected(&[0b1000_0000]),
            Err(SchedulerError::AvailabilityUnderflow(0))
        );
    }
}
