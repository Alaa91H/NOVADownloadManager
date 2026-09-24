use crate::{
    FilePriority, ResumeError, TorrentMetainfo, TorrentSelection, TorrentResumeCheckpoint,
    load_checkpoint_recovering, save_checkpoint_atomic,
};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

const CONTROL_DIR_NAME: &str = ".nova-torrent";
const RESUME_FILE_NAME: &str = "resume.state";
const BOUNDARY_DIR_NAME: &str = "boundary";
const FULL_ALLOCATION_CHUNK: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AllocationMode {
    None,
    #[default]
    Sparse,
    Full,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RecheckMode {
    #[default]
    CheckpointOnly,
    Full,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PieceCommit {
    pub piece_index: usize,
    pub selected_bytes_written: u64,
    pub boundary_cached: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecheckReport {
    pub checked_pieces: usize,
    pub valid_pieces: usize,
    pub invalid_pieces: usize,
    pub recovered_pieces: usize,
    pub verified_piece_bytes: u64,
    pub selected_verified_bytes: u64,
}

#[derive(Debug)]
pub struct TorrentStorage {
    root: PathBuf,
    control_dir: PathBuf,
    boundary_dir: PathBuf,
    checkpoint_path: PathBuf,
    meta: TorrentMetainfo,
    selection: TorrentSelection,
    checkpoint: TorrentResumeCheckpoint,
}

impl TorrentStorage {
    pub fn create(
        root: impl AsRef<Path>,
        meta: TorrentMetainfo,
        selection: TorrentSelection,
        allocation: AllocationMode,
    ) -> Result<Self, StorageError> {
        validate_selection(&meta, &selection)?;
        let root = prepare_root(root.as_ref())?;
        reject_reserved_collision(&meta)?;
        let control_dir = control_dir(&root, meta.info_hash.to_hex());
        if control_dir.exists() {
            return Err(StorageError::ExistingResumeState(control_dir));
        }
        preflight_selected_files(&root, &meta, &selection)?;

        let boundary_dir = control_dir.join(BOUNDARY_DIR_NAME);
        ensure_safe_directory(&root, &control_dir)?;
        ensure_safe_directory(&root, &boundary_dir)?;
        let checkpoint_path = control_dir.join(RESUME_FILE_NAME);

        // Persist the torrent identity before creating payload files. If the
        // process stops during allocation, resume() can safely finish creating
        // the missing files instead of treating them as unrelated user data.
        let checkpoint = TorrentResumeCheckpoint::new(&meta, &selection)?;
        save_checkpoint_atomic(&checkpoint_path, &checkpoint)?;
        prepare_selected_files(&root, &meta, &selection, allocation, false)?;

        Ok(Self {
            root,
            control_dir,
            boundary_dir,
            checkpoint_path,
            meta,
            selection,
            checkpoint,
        })
    }

    pub fn resume(
        root: impl AsRef<Path>,
        meta: TorrentMetainfo,
    ) -> Result<Self, StorageError> {
        let root = prepare_root(root.as_ref())?;
        reject_reserved_collision(&meta)?;
        let control_dir = control_dir(&root, meta.info_hash.to_hex());
        ensure_existing_safe_directory(&root, &control_dir)?;
        let boundary_dir = control_dir.join(BOUNDARY_DIR_NAME);
        if boundary_dir.exists() {
            ensure_existing_safe_directory(&root, &boundary_dir)?;
        } else {
            ensure_safe_directory(&root, &boundary_dir)?;
        }
        let checkpoint_path = control_dir.join(RESUME_FILE_NAME);
        let checkpoint = load_checkpoint_recovering(&checkpoint_path, &meta)?
            .ok_or_else(|| StorageError::MissingResumeState(checkpoint_path.clone()))?;
        let selection = checkpoint.selection(&meta)?;
        prepare_selected_files(&root, &meta, &selection, AllocationMode::Sparse, false)?;

        Ok(Self {
            root,
            control_dir,
            boundary_dir,
            checkpoint_path,
            meta,
            selection,
            checkpoint,
        })
    }

    pub fn open_or_create(
        root: impl AsRef<Path>,
        meta: TorrentMetainfo,
        selection: TorrentSelection,
        allocation: AllocationMode,
    ) -> Result<Self, StorageError> {
        let root_path = root.as_ref();
        let prepared_root = prepare_root(root_path)?;
        reject_reserved_collision(&meta)?;
        let checkpoint_path = control_dir(&prepared_root, meta.info_hash.to_hex())
            .join(RESUME_FILE_NAME);

        if checkpoint_path.exists()
            || append_suffix(&checkpoint_path, ".tmp").exists()
            || append_suffix(&checkpoint_path, ".bak").exists()
        {
            Self::resume(&prepared_root, meta)
        } else {
            Self::create(&prepared_root, meta, selection, allocation)
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn control_dir(&self) -> &Path {
        &self.control_dir
    }

    pub fn metainfo(&self) -> &TorrentMetainfo {
        &self.meta
    }

    pub fn selection(&self) -> &TorrentSelection {
        &self.selection
    }

    pub fn checkpoint(&self) -> &TorrentResumeCheckpoint {
        &self.checkpoint
    }

    pub fn begin_run(&mut self) -> Result<u64, StorageError> {
        let generation = self.checkpoint.next_generation()?;
        save_checkpoint_atomic(&self.checkpoint_path, &self.checkpoint)?;
        Ok(generation)
    }

    pub fn invalidate_run(&mut self) -> Result<u64, StorageError> {
        self.begin_run()
    }

    pub fn update_selection(
        &mut self,
        selection: TorrentSelection,
    ) -> Result<u64, StorageError> {
        validate_selection(&self.meta, &selection)?;
        prepare_selected_files(
            &self.root,
            &self.meta,
            &selection,
            AllocationMode::Sparse,
            false,
        )?;
        self.selection = selection;
        self.checkpoint.priorities = self.selection.priorities().to_vec();
        let generation = self.checkpoint.next_generation()?;
        save_checkpoint_atomic(&self.checkpoint_path, &self.checkpoint)?;
        Ok(generation)
    }

    pub fn write_verified_piece(
        &mut self,
        generation: u64,
        piece_index: usize,
        bytes: &[u8],
    ) -> Result<PieceCommit, StorageError> {
        self.ensure_generation(generation)?;
        let priority = self.selection.piece_priority(&self.meta, piece_index)?;
        if !priority.is_selected() {
            return Err(StorageError::PieceNotSelected(piece_index));
        }
        if !self.meta.verify_piece(piece_index, bytes)? {
            return Err(StorageError::PieceHashMismatch(piece_index));
        }

        let piece_start = (piece_index as u64)
            .checked_mul(self.meta.piece_length)
            .ok_or(StorageError::LengthOverflow)?;
        let piece_size = self
            .meta
            .piece_size(piece_index)
            .ok_or(StorageError::PieceOutOfRange(piece_index))?;
        let slices = self.meta.map_range(piece_start, piece_size)?;
        let mut selected_bytes_written = 0u64;

        for slice in &slices {
            let file_priority = self
                .selection
                .file_priority(slice.file_index)
                .ok_or(StorageError::FileIndexOutOfRange(slice.file_index))?;
            if !file_priority.is_selected() {
                continue;
            }
            let relative_start = slice
                .data_offset
                .checked_sub(piece_start)
                .ok_or(StorageError::LengthOverflow)?;
            let relative_end = relative_start
                .checked_add(slice.length)
                .ok_or(StorageError::LengthOverflow)?;
            let start = usize::try_from(relative_start).map_err(|_| StorageError::LengthOverflow)?;
            let end = usize::try_from(relative_end).map_err(|_| StorageError::LengthOverflow)?;
            let data = bytes
                .get(start..end)
                .ok_or(StorageError::PieceSliceOutsideBuffer(piece_index))?;
            self.write_file_slice(slice.file_index, slice.file_offset, data)?;
            selected_bytes_written = selected_bytes_written
                .checked_add(slice.length)
                .ok_or(StorageError::LengthOverflow)?;
        }

        let boundary_cached = self.selection.piece_is_boundary(&self.meta, piece_index)?;
        if boundary_cached {
            self.write_boundary_cache(piece_index, bytes)?;
        } else {
            self.remove_boundary_cache(piece_index);
        }

        self.ensure_generation(generation)?;
        self.checkpoint.verified.set(piece_index, true)?;
        self.checkpoint
            .boundary_cache
            .set(piece_index, boundary_cached)?;
        save_checkpoint_atomic(&self.checkpoint_path, &self.checkpoint)?;

        Ok(PieceCommit {
            piece_index,
            selected_bytes_written,
            boundary_cached,
        })
    }

    pub fn startup_recheck(
        &mut self,
        mode: RecheckMode,
    ) -> Result<RecheckReport, StorageError> {
        let mut report = RecheckReport::default();
        let mut changed = false;

        for piece_index in 0..self.meta.piece_count() {
            let priority = self.selection.piece_priority(&self.meta, piece_index)?;
            let was_verified = self.checkpoint.verified.is_set(piece_index)?;

            if !priority.is_selected() {
                if was_verified {
                    self.checkpoint.verified.set(piece_index, false)?;
                    changed = true;
                }
                if self.checkpoint.boundary_cache.is_set(piece_index)? {
                    self.checkpoint.boundary_cache.set(piece_index, false)?;
                    self.remove_boundary_cache(piece_index);
                    changed = true;
                }
                continue;
            }

            let should_check = was_verified || matches!(mode, RecheckMode::Full);
            if !should_check {
                continue;
            }
            report.checked_pieces += 1;

            let piece = match self.read_materialized_piece(piece_index) {
                Ok(piece) => piece,
                Err(_) => {
                    if was_verified {
                        self.checkpoint.verified.set(piece_index, false)?;
                        self.checkpoint.boundary_cache.set(piece_index, false)?;
                        changed = true;
                    }
                    report.invalid_pieces += 1;
                    continue;
                }
            };

            let valid = self.meta.verify_piece(piece_index, &piece).unwrap_or(false);
            if valid {
                report.valid_pieces += 1;
                if !was_verified {
                    self.checkpoint.verified.set(piece_index, true)?;
                    report.recovered_pieces += 1;
                    changed = true;
                }

                let boundary = self.selection.piece_is_boundary(&self.meta, piece_index)?;
                let had_boundary = self.checkpoint.boundary_cache.is_set(piece_index)?;
                if boundary != had_boundary {
                    self.checkpoint.boundary_cache.set(piece_index, boundary)?;
                    changed = true;
                }

                let piece_size = self
                    .meta
                    .piece_size(piece_index)
                    .ok_or(StorageError::PieceOutOfRange(piece_index))?;
                report.verified_piece_bytes = report
                    .verified_piece_bytes
                    .checked_add(piece_size)
                    .ok_or(StorageError::LengthOverflow)?;
                report.selected_verified_bytes = report
                    .selected_verified_bytes
                    .checked_add(self.selected_bytes_in_piece(piece_index)?)
                    .ok_or(StorageError::LengthOverflow)?;
            } else {
                report.invalid_pieces += 1;
                if was_verified {
                    self.checkpoint.verified.set(piece_index, false)?;
                    changed = true;
                }
                if self.checkpoint.boundary_cache.is_set(piece_index)? {
                    self.checkpoint.boundary_cache.set(piece_index, false)?;
                    changed = true;
                }
                self.remove_boundary_cache(piece_index);
            }
        }

        if changed {
            save_checkpoint_atomic(&self.checkpoint_path, &self.checkpoint)?;
        }
        Ok(report)
    }

    pub fn selected_completed_bytes(&self) -> Result<u64, StorageError> {
        let mut total = 0u64;
        for piece_index in 0..self.meta.piece_count() {
            if self.checkpoint.verified.is_set(piece_index)?
                && self
                    .selection
                    .piece_priority(&self.meta, piece_index)?
                    .is_selected()
            {
                total = total
                    .checked_add(self.selected_bytes_in_piece(piece_index)?)
                    .ok_or(StorageError::LengthOverflow)?;
            }
        }
        Ok(total)
    }

    pub fn selected_total_bytes(&self) -> Result<u64, StorageError> {
        Ok(self.selection.selected_bytes(&self.meta)?)
    }

    pub fn is_selected_complete(&self) -> Result<bool, StorageError> {
        for piece_index in 0..self.meta.piece_count() {
            if self
                .selection
                .piece_priority(&self.meta, piece_index)?
                .is_selected()
                && !self.checkpoint.verified.is_set(piece_index)?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn finalize_selected(&mut self, generation: u64) -> Result<(), StorageError> {
        self.ensure_generation(generation)?;
        if !self.is_selected_complete()? {
            return Err(StorageError::SelectionIncomplete);
        }

        for (index, file) in self.meta.files.iter().enumerate() {
            let priority = self
                .selection
                .file_priority(index)
                .ok_or(StorageError::FileIndexOutOfRange(index))?;
            if !priority.is_selected() {
                continue;
            }
            let path = target_path(&self.root, &file.path)?;
            ensure_target_not_symlink(&path)?;
            let handle = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
            handle
                .set_len(file.length)
                .and_then(|_| handle.sync_all())
                .map_err(|error| StorageError::Io(path, error.to_string()))?;
        }
        Ok(())
    }

    pub fn cleanup_resume_state(self) -> Result<(), StorageError> {
        if self.control_dir.exists() {
            std::fs::remove_dir_all(&self.control_dir)
                .map_err(|error| StorageError::Io(self.control_dir.clone(), error.to_string()))?;
        }
        Ok(())
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), StorageError> {
        if self.checkpoint.generation != generation {
            Err(StorageError::StaleGeneration {
                expected: self.checkpoint.generation,
                actual: generation,
            })
        } else {
            Ok(())
        }
    }

    fn selected_bytes_in_piece(&self, piece_index: usize) -> Result<u64, StorageError> {
        let piece_start = (piece_index as u64)
            .checked_mul(self.meta.piece_length)
            .ok_or(StorageError::LengthOverflow)?;
        let piece_size = self
            .meta
            .piece_size(piece_index)
            .ok_or(StorageError::PieceOutOfRange(piece_index))?;
        let slices = self.meta.map_range(piece_start, piece_size)?;
        let mut total = 0u64;
        for slice in slices {
            if self
                .selection
                .file_priority(slice.file_index)
                .is_some_and(FilePriority::is_selected)
            {
                total = total
                    .checked_add(slice.length)
                    .ok_or(StorageError::LengthOverflow)?;
            }
        }
        Ok(total)
    }

    fn write_file_slice(
        &self,
        file_index: usize,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), StorageError> {
        let file = self
            .meta
            .files
            .get(file_index)
            .ok_or(StorageError::FileIndexOutOfRange(file_index))?;
        let path = target_path(&self.root, &file.path)?;
        ensure_target_not_symlink(&path)?;
        let mut handle = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
        handle
            .seek(SeekFrom::Start(offset))
            .and_then(|_| handle.write_all(bytes))
            .and_then(|_| handle.sync_data())
            .map_err(|error| StorageError::Io(path, error.to_string()))
    }

    fn write_boundary_cache(
        &self,
        piece_index: usize,
        bytes: &[u8],
    ) -> Result<(), StorageError> {
        ensure_safe_directory(&self.root, &self.boundary_dir)?;
        let path = self.boundary_piece_path(piece_index);
        let tmp = append_suffix(&path, ".tmp");
        {
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|error| StorageError::Io(tmp.clone(), error.to_string()))?;
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| StorageError::Io(tmp.clone(), error.to_string()))?;
        }
        if path.exists() {
            ensure_target_not_symlink(&path)?;
            std::fs::remove_file(&path)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
        }
        std::fs::rename(&tmp, &path)
            .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
        sync_parent(&path);
        Ok(())
    }

    fn read_materialized_piece(&self, piece_index: usize) -> Result<Vec<u8>, StorageError> {
        let piece_size = self
            .meta
            .piece_size(piece_index)
            .ok_or(StorageError::PieceOutOfRange(piece_index))?;
        let piece_len = usize::try_from(piece_size).map_err(|_| StorageError::LengthOverflow)?;
        let boundary = self.selection.piece_is_boundary(&self.meta, piece_index)?;

        if boundary {
            let path = self.boundary_piece_path(piece_index);
            ensure_target_not_symlink(&path)?;
            let bytes = std::fs::read(&path)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
            if bytes.len() != piece_len {
                return Err(StorageError::CachedPieceLengthMismatch {
                    piece_index,
                    expected: piece_len,
                    actual: bytes.len(),
                });
            }
            return Ok(bytes);
        }

        let piece_start = (piece_index as u64)
            .checked_mul(self.meta.piece_length)
            .ok_or(StorageError::LengthOverflow)?;
        let slices = self.meta.map_range(piece_start, piece_size)?;
        let mut piece = vec![0u8; piece_len];

        for slice in slices {
            let priority = self
                .selection
                .file_priority(slice.file_index)
                .ok_or(StorageError::FileIndexOutOfRange(slice.file_index))?;
            if !priority.is_selected() {
                return Err(StorageError::MissingBoundaryCache(piece_index));
            }
            let file = self
                .meta
                .files
                .get(slice.file_index)
                .ok_or(StorageError::FileIndexOutOfRange(slice.file_index))?;
            let path = target_path(&self.root, &file.path)?;
            ensure_target_not_symlink(&path)?;
            let mut handle = File::open(&path)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
            handle
                .seek(SeekFrom::Start(slice.file_offset))
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;

            let relative = slice
                .data_offset
                .checked_sub(piece_start)
                .ok_or(StorageError::LengthOverflow)?;
            let start = usize::try_from(relative).map_err(|_| StorageError::LengthOverflow)?;
            let length = usize::try_from(slice.length).map_err(|_| StorageError::LengthOverflow)?;
            let end = start.checked_add(length).ok_or(StorageError::LengthOverflow)?;
            let destination = piece
                .get_mut(start..end)
                .ok_or(StorageError::PieceSliceOutsideBuffer(piece_index))?;
            handle
                .read_exact(destination)
                .map_err(|error| StorageError::Io(path, error.to_string()))?;
        }

        Ok(piece)
    }

    fn boundary_piece_path(&self, piece_index: usize) -> PathBuf {
        self.boundary_dir.join(format!("{piece_index:08x}.piece"))
    }

    fn remove_boundary_cache(&self, piece_index: usize) {
        let _ = std::fs::remove_file(self.boundary_piece_path(piece_index));
        let _ = std::fs::remove_file(append_suffix(
            &self.boundary_piece_path(piece_index),
            ".tmp",
        ));
    }
}

fn validate_selection(
    meta: &TorrentMetainfo,
    selection: &TorrentSelection,
) -> Result<(), StorageError> {
    if selection.priorities().len() != meta.files.len() {
        return Err(StorageError::SelectionMismatch {
            expected: meta.files.len(),
            actual: selection.priorities().len(),
        });
    }
    let _ = selection.selected_bytes(meta)?;
    Ok(())
}

fn prepare_root(root: &Path) -> Result<PathBuf, StorageError> {
    std::fs::create_dir_all(root)
        .map_err(|error| StorageError::Io(root.to_path_buf(), error.to_string()))?;
    std::fs::canonicalize(root)
        .map_err(|error| StorageError::Io(root.to_path_buf(), error.to_string()))
}

fn reject_reserved_collision(meta: &TorrentMetainfo) -> Result<(), StorageError> {
    for file in &meta.files {
        let path = Path::new(&file.path);
        if path.components().next().is_some_and(|component| {
            matches!(
                component,
                Component::Normal(value)
                    if value == std::ffi::OsStr::new(CONTROL_DIR_NAME)
            )
        }) {
            return Err(StorageError::ReservedPathCollision(file.path.clone()));
        }
    }
    Ok(())
}

fn control_dir(root: &Path, info_hash: String) -> PathBuf {
    root.join(CONTROL_DIR_NAME).join(info_hash)
}

fn preflight_selected_files(
    root: &Path,
    meta: &TorrentMetainfo,
    selection: &TorrentSelection,
) -> Result<(), StorageError> {
    for (index, file) in meta.files.iter().enumerate() {
        let priority = selection
            .file_priority(index)
            .ok_or(StorageError::FileIndexOutOfRange(index))?;
        if !priority.is_selected() {
            continue;
        }
        let path = target_path(root, &file.path)?;
        if path.exists() {
            ensure_target_not_symlink(&path)?;
            return Err(StorageError::ExistingTarget(path));
        }
        if let Some(parent) = path.parent() {
            let mut current = root.to_path_buf();
            let relative = parent
                .strip_prefix(root)
                .map_err(|_| StorageError::UnsafePath(parent.display().to_string()))?;
            for component in relative.components() {
                let Component::Normal(value) = component else {
                    return Err(StorageError::UnsafePath(parent.display().to_string()));
                };
                current.push(value);
                if current.exists() {
                    let metadata = std::fs::symlink_metadata(&current)
                        .map_err(|error| StorageError::Io(current.clone(), error.to_string()))?;
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(StorageError::SymlinkOrNonDirectory(current));
                    }
                }
            }
        }
    }
    Ok(())
}

fn prepare_selected_files(
    root: &Path,
    meta: &TorrentMetainfo,
    selection: &TorrentSelection,
    allocation: AllocationMode,
    create_new: bool,
) -> Result<(), StorageError> {
    for (index, file) in meta.files.iter().enumerate() {
        let priority = selection
            .file_priority(index)
            .ok_or(StorageError::FileIndexOutOfRange(index))?;
        if !priority.is_selected() {
            continue;
        }
        let path = target_path(root, &file.path)?;
        let parent = path
            .parent()
            .ok_or_else(|| StorageError::UnsafePath(file.path.clone()))?;
        ensure_safe_directory(root, parent)?;
        ensure_target_not_symlink(&path)?;

        if create_new && path.exists() {
            return Err(StorageError::ExistingTarget(path));
        }

        if !path.exists() {
            let mut handle = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
            allocate_file(&mut handle, file.length, allocation)
                .map_err(|error| StorageError::Io(path.clone(), error.to_string()))?;
        }
    }
    Ok(())
}

fn allocate_file(
    file: &mut File,
    length: u64,
    allocation: AllocationMode,
) -> std::io::Result<()> {
    match allocation {
        AllocationMode::None => Ok(()),
        AllocationMode::Sparse => {
            file.set_len(length)?;
            file.sync_all()
        }
        AllocationMode::Full => {
            file.set_len(0)?;
            let zeroes = vec![0u8; FULL_ALLOCATION_CHUNK];
            let mut remaining = length;
            while remaining > 0 {
                let take = remaining.min(zeroes.len() as u64) as usize;
                file.write_all(&zeroes[..take])?;
                remaining -= take as u64;
            }
            file.sync_all()
        }
    }
}

fn target_path(root: &Path, relative: &str) -> Result<PathBuf, StorageError> {
    let relative = Path::new(relative);
    if relative.is_absolute() {
        return Err(StorageError::UnsafePath(relative.display().to_string()));
    }
    for component in relative.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(StorageError::UnsafePath(relative.display().to_string())),
        }
    }
    Ok(root.join(relative))
}

fn ensure_safe_directory(root: &Path, directory: &Path) -> Result<(), StorageError> {
    if !directory.starts_with(root) {
        return Err(StorageError::UnsafePath(directory.display().to_string()));
    }

    let relative = directory
        .strip_prefix(root)
        .map_err(|_| StorageError::UnsafePath(directory.display().to_string()))?;
    let mut current = root.to_path_buf();

    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(StorageError::UnsafePath(directory.display().to_string()));
        };
        current.push(value);
        if current.exists() {
            let metadata = std::fs::symlink_metadata(&current)
                .map_err(|error| StorageError::Io(current.clone(), error.to_string()))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StorageError::SymlinkOrNonDirectory(current));
            }
        } else {
            std::fs::create_dir(&current)
                .map_err(|error| StorageError::Io(current.clone(), error.to_string()))?;
        }
    }

    let canonical = std::fs::canonicalize(directory)
        .map_err(|error| StorageError::Io(directory.to_path_buf(), error.to_string()))?;
    if !canonical.starts_with(root) {
        return Err(StorageError::UnsafePath(directory.display().to_string()));
    }
    Ok(())
}

fn ensure_existing_safe_directory(root: &Path, directory: &Path) -> Result<(), StorageError> {
    if !directory.exists() {
        return Err(StorageError::MissingResumeState(directory.to_path_buf()));
    }
    ensure_safe_directory(root, directory)
}

fn ensure_target_not_symlink(path: &Path) -> Result<(), StorageError> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| StorageError::Io(path.to_path_buf(), error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        Err(StorageError::SymlinkOrNonFile(path.to_path_buf()))
    } else {
        Ok(())
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Resume(#[from] ResumeError),
    #[error(transparent)]
    Selection(#[from] crate::SelectionError),
    #[error(transparent)]
    Metainfo(#[from] crate::TorrentMetainfoError),
    #[error("torrent storage selection count mismatch: expected {expected}, got {actual}")]
    SelectionMismatch { expected: usize, actual: usize },
    #[error("torrent storage file index {0} is outside metainfo")]
    FileIndexOutOfRange(usize),
    #[error("torrent storage piece {0} is outside metainfo")]
    PieceOutOfRange(usize),
    #[error("torrent piece {0} is not selected for download")]
    PieceNotSelected(usize),
    #[error("torrent piece {0} failed SHA-1 verification")]
    PieceHashMismatch(usize),
    #[error("torrent piece {0} slice points outside the verified buffer")]
    PieceSliceOutsideBuffer(usize),
    #[error("torrent boundary piece {0} has no durable cache")]
    MissingBoundaryCache(usize),
    #[error("cached torrent piece {piece_index} length mismatch: expected {expected}, got {actual}")]
    CachedPieceLengthMismatch {
        piece_index: usize,
        expected: usize,
        actual: usize,
    },
    #[error("torrent storage length arithmetic overflow")]
    LengthOverflow,
    #[error("torrent storage run generation is stale: expected {expected}, got {actual}")]
    StaleGeneration { expected: u64, actual: u64 },
    #[error("selected torrent files are not complete")]
    SelectionIncomplete,
    #[error("torrent storage path is unsafe: {0}")]
    UnsafePath(String),
    #[error("torrent path collides with reserved NOVA control directory: {0}")]
    ReservedPathCollision(String),
    #[error("torrent target already exists: {0}")]
    ExistingTarget(PathBuf),
    #[error("torrent resume state already exists: {0}")]
    ExistingResumeState(PathBuf),
    #[error("torrent resume state is missing: {0}")]
    MissingResumeState(PathBuf),
    #[error("torrent storage directory is a symlink or non-directory: {0}")]
    SymlinkOrNonDirectory(PathBuf),
    #[error("torrent target is a symlink or non-file: {0}")]
    SymlinkOrNonFile(PathBuf),
    #[error("torrent storage I/O error at {0}: {1}")]
    Io(PathBuf, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{InfoHash, TorrentFile};
    use sha1::{Digest, Sha1};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "nova-torrent-storage-{}-{stamp}-{name}",
            std::process::id()
        ))
    }

    fn hash(bytes: &[u8]) -> [u8; 20] {
        let digest = Sha1::digest(bytes);
        let mut output = [0u8; 20];
        output.copy_from_slice(&digest);
        output
    }

    fn multi_meta() -> TorrentMetainfo {
        let p0 = b"abcd";
        let p1 = b"efgh";
        TorrentMetainfo {
            info_hash: InfoHash::new([4u8; 20]),
            name: "bundle".to_owned(),
            piece_length: 4,
            piece_hashes: vec![hash(p0), hash(p1)],
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
    fn boundary_piece_writes_only_selected_file_and_caches_full_verified_piece() {
        let root = temp_root("boundary");
        let meta = multi_meta();
        let selection = TorrentSelection::new(
            &meta,
            vec![FilePriority::Skip, FilePriority::High],
        )
        .unwrap();
        let mut storage =
            TorrentStorage::create(&root, meta.clone(), selection, AllocationMode::Sparse)
                .unwrap();
        let generation = storage.begin_run().unwrap();

        let commit = storage
            .write_verified_piece(generation, 0, b"abcd")
            .expect("commit boundary");
        assert_eq!(commit.selected_bytes_written, 1);
        assert!(commit.boundary_cached);
        assert!(!root.join("bundle/a.bin").exists());

        let mut selected = Vec::new();
        File::open(root.join("bundle/b.bin"))
            .unwrap()
            .read_to_end(&mut selected)
            .unwrap();
        assert_eq!(selected[0], b'd');

        let report = storage.startup_recheck(RecheckMode::CheckpointOnly).unwrap();
        assert_eq!(report.valid_pieces, 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn full_recheck_recovers_piece_written_before_checkpoint_commit() {
        let root = temp_root("recover");
        let meta = multi_meta();
        let selection = TorrentSelection::all(&meta);
        let mut storage =
            TorrentStorage::create(&root, meta.clone(), selection, AllocationMode::Sparse)
                .unwrap();

        let path_a = root.join("bundle/a.bin");
        let path_b = root.join("bundle/b.bin");
        {
            let mut a = OpenOptions::new().write(true).open(&path_a).unwrap();
            a.write_all(b"abc").unwrap();
            a.sync_all().unwrap();
            let mut b = OpenOptions::new().write(true).open(&path_b).unwrap();
            b.write_all(b"d").unwrap();
            b.sync_all().unwrap();
        }

        let report = storage.startup_recheck(RecheckMode::Full).unwrap();
        assert_eq!(report.recovered_pieces, 1);
        assert!(storage.checkpoint().verified.is_set(0).unwrap());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resume_rejects_corrupted_piece_and_clears_bitmap() {
        let root = temp_root("corrupt");
        let meta = multi_meta();
        let selection = TorrentSelection::all(&meta);
        let mut storage =
            TorrentStorage::create(&root, meta.clone(), selection, AllocationMode::Sparse)
                .unwrap();
        let generation = storage.begin_run().unwrap();
        storage
            .write_verified_piece(generation, 1, b"efgh")
            .unwrap();
        drop(storage);

        let path = root.join("bundle/b.bin");
        let mut file = OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(1)).unwrap();
        file.write_all(b"X").unwrap();
        file.sync_all().unwrap();
        drop(file);

        let mut resumed = TorrentStorage::resume(&root, meta).unwrap();
        let report = resumed
            .startup_recheck(RecheckMode::CheckpointOnly)
            .unwrap();
        assert_eq!(report.invalid_pieces, 1);
        assert!(!resumed.checkpoint().verified.is_set(1).unwrap());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_generation_cannot_commit_piece() {
        let root = temp_root("generation");
        let meta = multi_meta();
        let selection = TorrentSelection::all(&meta);
        let mut storage =
            TorrentStorage::create(&root, meta, selection, AllocationMode::Sparse).unwrap();
        let generation = storage.begin_run().unwrap();
        let new_generation = storage.invalidate_run().unwrap();
        assert!(new_generation > generation);
        assert!(matches!(
            storage.write_verified_piece(generation, 0, b"abcd"),
            Err(StorageError::StaleGeneration { .. })
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn create_refuses_to_clobber_existing_user_file() {
        let root = temp_root("existing");
        std::fs::create_dir_all(root.join("bundle")).unwrap();
        std::fs::write(root.join("bundle/a.bin"), b"user-data").unwrap();
        let meta = multi_meta();
        let selection = TorrentSelection::all(&meta);
        assert!(matches!(
            TorrentStorage::create(&root, meta, selection, AllocationMode::Sparse),
            Err(StorageError::ExistingTarget(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }
}
