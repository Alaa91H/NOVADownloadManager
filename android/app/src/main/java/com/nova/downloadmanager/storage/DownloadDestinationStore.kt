package com.nova.downloadmanager.storage

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

sealed interface DownloadDestination {
    data object AppPrivate : DownloadDestination
    data object MediaStoreDownloads : DownloadDestination
    data class SafTree(val grantId: String) : DownloadDestination
}

/** Android owns URI grants/publication. Rust writes verified private staging only. */
class DownloadDestinationStore(context: Context) {
    private val app = context.applicationContext
    private val preferences = app.getSharedPreferences("nova_download_destinations", Context.MODE_PRIVATE)
    private val resolver = app.contentResolver

    fun selected(): DownloadDestination = decode(preferences.getString("selected", null))

    fun select(destination: DownloadDestination) {
        if (destination is DownloadDestination.MediaStoreDownloads) {
            require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        }
        if (destination is DownloadDestination.SafTree) requireGrant(destination.grantId)
        persist("selected", encode(destination))
    }

    fun selectTree(uri: Uri) {
        require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri))
        resolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val grant = UUID.randomUUID().toString()
        persist("grant.$grant", uri.toString())
        select(DownloadDestination.SafTree(grant))
    }

    /** Freeze the selected destination when accepting the task, never at completion. */
    fun bindTask(taskId: String) = persist("task.$taskId.destination", encode(selected()))

    /** Compensate task creation if catalog or encrypted-intent persistence fails. */
    fun rollbackTaskBinding(taskId: String) = synchronized(PUBLICATION_LOCK) {
        val destination = decode(preferences.getString("task.$taskId.destination", null))
        preferences.getString("task.$taskId.pending", null)?.let { pending ->
            runCatching { deleteOwned(destination, Uri.parse(pending)) }
        }
        check(
            preferences.edit()
                .remove("task.$taskId.destination")
                .remove("task.$taskId.pending")
                .remove("task.$taskId.complete")
                .commit(),
        ) { "Failed to roll back NOVA task destination binding" }
    }

    /** A user retry after failure adopts the destination currently selected in Settings. */
    fun rebindTaskToSelected(taskId: String) = synchronized(PUBLICATION_LOCK) {
        val destinationKey = "task.$taskId.destination"
        val pendingKey = "task.$taskId.pending"
        val oldDestination = decode(preferences.getString(destinationKey, null))
        val newDestination = selected()
        if (oldDestination != newDestination) {
            preferences.getString(pendingKey, null)?.let { pendingUri ->
                runCatching { deleteOwned(oldDestination, Uri.parse(pendingUri)) }
            }
            check(
                preferences.edit()
                    .putString(destinationKey, encode(newDestination))
                    .remove(pendingKey)
                    .commit(),
            ) { "Retry destination could not be saved" }
        } else if (!preferences.contains(destinationKey)) {
            persist(destinationKey, encode(newDestination))
        }
    }

    /** Move a retry to the current choice only when its original destination was revoked. */
    fun recoverRevokedTaskDestination(taskId: String) {
        val key = "task.$taskId.destination"
        val destination = decode(preferences.getString(key, null))
        val usable = when (destination) {
            is DownloadDestination.SafTree -> runCatching { requireGrant(destination.grantId) }.isSuccess
            DownloadDestination.MediaStoreDownloads -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            DownloadDestination.AppPrivate -> true
        }
        if (!usable) {
            val pendingKey = "task.$taskId.pending"
            preferences.getString(pendingKey, null)?.let { pendingUri ->
                runCatching { deleteOwned(destination, Uri.parse(pendingUri)) }
            }
            check(preferences.edit().remove(pendingKey).commit()) {
                "Destination recovery state could not be saved"
            }
            bindTask(taskId)
        }
    }

    fun completedUri(taskId: String): Uri? = preferences.getString("task.$taskId.complete", null)?.let(Uri::parse)

    fun retainsPrivateCopy(taskId: String): Boolean =
        decode(preferences.getString("task.$taskId.destination", null)) is DownloadDestination.AppPrivate

    /** Preserve Open access for completed records written before destination journalling existed. */
    fun restoreLegacyPrivateCompletion(taskId: String, source: File): Uri? = synchronized(PUBLICATION_LOCK) {
        completedUri(taskId)?.let { return@synchronized it }
        if (preferences.contains("task.$taskId.destination") || !source.isFile) return@synchronized null
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.downloads", source)
        check(
            preferences.edit()
                .putString("task.$taskId.destination", encode(DownloadDestination.AppPrivate))
                .putString("task.$taskId.complete", uri.toString())
                .commit(),
        ) { "Legacy completed destination could not be restored" }
        uri
    }

    /** Resume a pending publication by truncating only the document this task created. */
    fun publish(taskId: String, source: File, name: String, checkControl: () -> Unit = {}): Uri =
        synchronized(PUBLICATION_LOCK) {
            publishLocked(taskId, source, name, checkControl)
        }

    private fun publishLocked(taskId: String, source: File, name: String, checkControl: () -> Unit): Uri {
        check(source.isFile) { "Verified download is unavailable" }
        completedUri(taskId)?.let { uri ->
            resolver.openInputStream(uri)?.use { return uri }
            throw IOException("Published download is unavailable")
        }
        val destination = decode(preferences.getString("task.$taskId.destination", null))
        if (destination is DownloadDestination.AppPrivate) {
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.downloads", source)
            checkControl()
            persist("task.$taskId.complete", uri.toString())
            return uri
        }
        val safeName = safeName(name)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(safeName.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        if (destination is DownloadDestination.SafTree) requireGrant(destination.grantId)
        val pendingKey = "task.$taskId.pending"
        val pending = preferences.getString(pendingKey, null)?.let(Uri::parse)
            ?: createPending(destination, taskId, safeName, mime).also { uri ->
                try {
                    persist(pendingKey, uri.toString())
                } catch (error: Exception) {
                    deleteOwned(destination, uri)
                    throw error
                }
            }
        checkControl()
        val expectedDigest = MessageDigest.getInstance("SHA-256")
        var copied = 0L
        val expectedBytes = source.length()
        source.inputStream().use { input ->
            (resolver.openOutputStream(pending, "wt") ?: throw IOException("Destination cannot be opened")).use { output ->
                val buffer = ByteArray(128 * 1024)
                while (true) {
                    checkControl()
                    val count = input.read(buffer)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    expectedDigest.update(buffer, 0, count)
                    copied += count
                }
                output.flush()
            }
        }
        check(copied == expectedBytes && source.length() == expectedBytes) { "Download changed during publication" }
        val actualDigest = MessageDigest.getInstance("SHA-256")
        var verified = 0L
        (resolver.openInputStream(pending) ?: throw IOException("Destination cannot be verified")).use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                checkControl()
                val count = input.read(buffer)
                if (count < 0) break
                actualDigest.update(buffer, 0, count)
                verified += count
            }
        }
        check(verified == expectedBytes && MessageDigest.isEqual(expectedDigest.digest(), actualDigest.digest())) {
            "Destination integrity verification failed"
        }
        checkControl()
        val committed = when (destination) {
            DownloadDestination.MediaStoreDownloads -> {
                check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                check(resolver.update(pending, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) == 1) {
                    "Destination could not be published"
                }
                pending
            }
            is DownloadDestination.SafTree -> {
                // Keep a stable task-derived name: an interrupted commit can reuse
                // the same document URI without renaming into another provider ID.
                pending
            }
            DownloadDestination.AppPrivate -> error("Private publication is handled above")
        }
        check(preferences.edit().putString("task.$taskId.complete", committed.toString()).remove(pendingKey).commit()) {
            "Publication state could not be saved"
        }
        return committed
    }

    fun cancelPending(taskId: String) {
        synchronized(PUBLICATION_LOCK) {
            // Never delete a finalized file from a cancellation of an old generation.
            if (completedUri(taskId) != null) return
            val key = "task.$taskId.pending"
            val destination = decode(preferences.getString("task.$taskId.destination", null))
            preferences.getString(key, null)?.let { uri ->
                // A revoked SAF grant must not turn a completed native cancel
                // into a failed transfer action. The provider may retain its
                // orphan, but the app drops the unusable recovery journal.
                runCatching { deleteOwned(destination, Uri.parse(uri)) }
            }
            check(preferences.edit().remove(key).remove("task.$taskId.destination").commit())
        }
    }

    private fun createPending(destination: DownloadDestination, taskId: String, name: String, mime: String): Uri {
        val uniqueName = "$taskId-$name"
        return when (destination) {
            DownloadDestination.MediaStoreDownloads -> {
                check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
                // Reconcile an insert whose URI could not be journalled before process death.
                resolver.query(collection, arrayOf(MediaStore.Downloads._ID),
                    "${MediaStore.Downloads.DISPLAY_NAME} = ? AND ${MediaStore.Downloads.RELATIVE_PATH} = ?",
                    arrayOf(uniqueName, "${Environment.DIRECTORY_DOWNLOADS}/NOVA/"), null)?.use { cursor ->
                    if (cursor.moveToFirst()) return Uri.withAppendedPath(collection, cursor.getLong(0).toString())
                }
                resolver.insert(collection, ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, uniqueName)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/NOVA/")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }) ?: throw IOException("Downloads destination unavailable")
            }
            is DownloadDestination.SafTree -> {
                val tree = requireGrant(destination.grantId)
                val treeId = DocumentsContract.getTreeDocumentId(tree)
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeId)
                val stableName = "$taskId-$name"
                resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
                    while (cursor.moveToNext()) {
                        if (cursor.getString(1) == stableName) return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
                    }
                }
                DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, treeId), mime, stableName)
                    ?: throw IOException("Selected folder is unavailable")
            }
            DownloadDestination.AppPrivate -> error("No public document is needed")
        }
    }

    private fun requireGrant(id: String): Uri {
        val uri = preferences.getString("grant.$id", null)?.let(Uri::parse)
            ?: throw SecurityException("Destination permission is unavailable; select the folder again")
        check(resolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission && it.isReadPermission }) {
            "Destination permission was revoked; select the folder again"
        }
        return uri
    }

    private fun deleteOwned(destination: DownloadDestination, uri: Uri) {
        if (destination is DownloadDestination.SafTree) DocumentsContract.deleteDocument(resolver, uri)
        else if (destination is DownloadDestination.MediaStoreDownloads) resolver.delete(uri, null, null)
    }

    private fun persist(key: String, value: String) {
        check(preferences.edit().putString(key, value).commit()) { "Destination state could not be saved" }
    }

    private fun encode(destination: DownloadDestination): String = when (destination) {
        DownloadDestination.AppPrivate -> "private"
        DownloadDestination.MediaStoreDownloads -> "downloads"
        is DownloadDestination.SafTree -> "tree:${destination.grantId}"
    }

    private fun decode(value: String?): DownloadDestination = when {
        value == null || value == "private" -> DownloadDestination.AppPrivate
        value == "downloads" -> DownloadDestination.MediaStoreDownloads
        value.startsWith("tree:") -> DownloadDestination.SafTree(value.removePrefix("tree:"))
        else -> error("Unsupported destination; select a destination again")
    }

    companion object {
        private val PUBLICATION_LOCK = Any()
        internal fun safeName(name: String): String = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
            .trim('.', ' ', '_').take(120).ifBlank { "download" }
    }
}
