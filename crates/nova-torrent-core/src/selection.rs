use crate::{TorrentMetainfo, TorrentMetainfoError};
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase")]
pub enum FilePriority {
    Skip,
    #[default]
    Normal,
    High,
}

impl FilePriority {
    pub const fn is_selected(self) -> bool {
        !matches!(self, Self::Skip)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TorrentSelection {
    priorities: Vec<FilePriority>,
}

impl TorrentSelection {
    pub fn all(meta: &TorrentMetainfo) -> Self {
        Self {
            priorities: vec![FilePriority::Normal; meta.files.len()],
        }
    }

    pub fn new(
        meta: &TorrentMetainfo,
        priorities: Vec<FilePriority>,
    ) -> Result<Self, SelectionError> {
        if priorities.len() != meta.files.len() {
            return Err(SelectionError::FileCountMismatch {
                expected: meta.files.len(),
                actual: priorities.len(),
            });
        }
        if !priorities.iter().any(|priority| priority.is_selected()) {
            return Err(SelectionError::NothingSelected);
        }
        Ok(Self { priorities })
    }

    pub fn priorities(&self) -> &[FilePriority] {
        &self.priorities
    }

    pub fn file_priority(&self, index: usize) -> Option<FilePriority> {
        self.priorities.get(index).copied()
    }

    pub fn selected_bytes(&self, meta: &TorrentMetainfo) -> Result<u64, SelectionError> {
        self.validate(meta)?;
        meta.files
            .iter()
            .zip(&self.priorities)
            .filter(|(_, priority)| priority.is_selected())
            .try_fold(0u64, |total, (file, _)| {
                total
                    .checked_add(file.length)
                    .ok_or(SelectionError::LengthOverflow)
            })
    }

    pub fn piece_priority(
        &self,
        meta: &TorrentMetainfo,
        piece_index: usize,
    ) -> Result<FilePriority, SelectionError> {
        self.validate(meta)?;
        let size = meta
            .piece_size(piece_index)
            .ok_or(SelectionError::PieceOutOfRange {
                index: piece_index,
                count: meta.piece_count(),
            })?;
        let offset = (piece_index as u64)
            .checked_mul(meta.piece_length)
            .ok_or(SelectionError::LengthOverflow)?;
        let slices = meta.map_range(offset, size)?;

        let mut priority = FilePriority::Skip;
        for slice in slices {
            let current = self
                .priorities
                .get(slice.file_index)
                .copied()
                .ok_or(SelectionError::FileIndexOutOfRange(slice.file_index))?;
            priority = priority.max(current);
        }
        Ok(priority)
    }

    pub fn piece_has_skipped_slice(
        &self,
        meta: &TorrentMetainfo,
        piece_index: usize,
    ) -> Result<bool, SelectionError> {
        self.validate(meta)?;
        let size = meta
            .piece_size(piece_index)
            .ok_or(SelectionError::PieceOutOfRange {
                index: piece_index,
                count: meta.piece_count(),
            })?;
        let offset = (piece_index as u64)
            .checked_mul(meta.piece_length)
            .ok_or(SelectionError::LengthOverflow)?;
        let slices = meta.map_range(offset, size)?;
        Ok(slices.iter().any(|slice| {
            self.priorities
                .get(slice.file_index)
                .is_some_and(|priority| !priority.is_selected())
        }))
    }

    pub fn piece_is_boundary(
        &self,
        meta: &TorrentMetainfo,
        piece_index: usize,
    ) -> Result<bool, SelectionError> {
        let priority = self.piece_priority(meta, piece_index)?;
        if !priority.is_selected() {
            return Ok(false);
        }
        self.piece_has_skipped_slice(meta, piece_index)
    }

    pub fn piece_priorities(
        &self,
        meta: &TorrentMetainfo,
    ) -> Result<Vec<FilePriority>, SelectionError> {
        self.validate(meta)?;
        (0..meta.piece_count())
            .map(|index| self.piece_priority(meta, index))
            .collect()
    }

    fn validate(&self, meta: &TorrentMetainfo) -> Result<(), SelectionError> {
        if self.priorities.len() != meta.files.len() {
            return Err(SelectionError::FileCountMismatch {
                expected: meta.files.len(),
                actual: self.priorities.len(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum SelectionError {
    #[error("file-priority count mismatch: expected {expected}, got {actual}")]
    FileCountMismatch { expected: usize, actual: usize },
    #[error("torrent selection cannot skip every file")]
    NothingSelected,
    #[error("torrent selection length arithmetic overflow")]
    LengthOverflow,
    #[error("torrent piece index {index} is outside piece count {count}")]
    PieceOutOfRange { index: usize, count: usize },
    #[error("torrent file index {0} is outside the selection")]
    FileIndexOutOfRange(usize),
    #[error(transparent)]
    Metainfo(#[from] TorrentMetainfoError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{InfoHash, TorrentFile};

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([1u8; 20]),
            name: "bundle".to_owned(),
            piece_length: 4,
            piece_hashes: vec![[0u8; 20], [0u8; 20]],
            files: vec![
                TorrentFile {
                    path: "bundle/a.bin".to_owned(),
                    length: 3,
                    offset: 0,
                },
                TorrentFile {
                    path: "bundle/b.bin".to_owned(),
                    length: 5,
                    offset: 3,
                },
            ],
            total_length: 8,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    #[test]
    fn piece_priority_uses_highest_overlapping_file_priority() {
        let meta = meta();
        let selection = TorrentSelection::new(
            &meta,
            vec![FilePriority::Skip, FilePriority::High],
        )
        .unwrap();
        assert_eq!(selection.piece_priority(&meta, 0), Ok(FilePriority::High));
        assert_eq!(selection.piece_priority(&meta, 1), Ok(FilePriority::High));
        assert_eq!(selection.piece_is_boundary(&meta, 0), Ok(true));
        assert_eq!(selection.piece_is_boundary(&meta, 1), Ok(false));
    }

    #[test]
    fn skipped_only_piece_is_not_selected() {
        let mut meta = meta();
        meta.files = vec![
            TorrentFile {
                path: "bundle/a.bin".to_owned(),
                length: 4,
                offset: 0,
            },
            TorrentFile {
                path: "bundle/b.bin".to_owned(),
                length: 4,
                offset: 4,
            },
        ];
        let selection = TorrentSelection::new(
            &meta,
            vec![FilePriority::Skip, FilePriority::Normal],
        )
        .unwrap();
        assert_eq!(selection.piece_priority(&meta, 0), Ok(FilePriority::Skip));
        assert_eq!(selection.piece_priority(&meta, 1), Ok(FilePriority::Normal));
        assert_eq!(selection.selected_bytes(&meta), Ok(4));
    }

    #[test]
    fn rejects_empty_selection() {
        let meta = meta();
        assert_eq!(
            TorrentSelection::new(&meta, vec![FilePriority::Skip, FilePriority::Skip]),
            Err(SelectionError::NothingSelected)
        );
    }
}
