package com.nova.downloadmanager.downloads

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import java.io.File
import java.net.URLConnection

internal data class NativeDestination(
    val uri: Uri,
    val descriptor: ParcelFileDescriptor,
    val publishOnComplete: Boolean,
)

internal class NativeDestinationStore(context: Context) {
    private val appContext = context.applicationContext
    private val resolver = appContext.contentResolver

    fun create(fileName: String): NativeDestination {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            createMediaStoreDestination(fileName)
        } else {
            createAppSpecificDestination(fileName)
        }
    }

    fun publish(uri: Uri, publishOnComplete: Boolean) {
        if (!publishOnComplete || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.IS_PENDING, 0)
        }
        check(resolver.update(uri, values, null, null) >= 0) {
            "NOVA could not publish the completed download"
        }
    }

    fun delete(uri: Uri, publishOnComplete: Boolean) {
        runCatching {
            if (publishOnComplete && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                resolver.delete(uri, null, null)
            } else if (uri.scheme == "file") {
                uri.path?.let(::File)?.delete()
            }
        }
    }

    private fun createMediaStoreDestination(fileName: String): NativeDestination {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(
                MediaStore.MediaColumns.MIME_TYPE,
                URLConnection.guessContentTypeFromName(fileName) ?: "application/octet-stream",
            )
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                "${Environment.DIRECTORY_DOWNLOADS}/NOVA",
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val uri = checkNotNull(
            resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values),
        ) { "NOVA could not create a MediaStore download destination" }

        val descriptor = try {
            checkNotNull(resolver.openFileDescriptor(uri, "rw")) {
                "NOVA could not open its MediaStore download destination"
            }
        } catch (failure: Throwable) {
            runCatching { resolver.delete(uri, null, null) }
            throw failure
        }

        return NativeDestination(
            uri = uri,
            descriptor = descriptor,
            publishOnComplete = true,
        )
    }

    private fun createAppSpecificDestination(fileName: String): NativeDestination {
        val downloadsRoot = appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: appContext.filesDir
        val novaDirectory = File(downloadsRoot, "NOVA").apply {
            check(exists() || mkdirs()) { "NOVA could not create its download directory" }
        }
        val file = uniqueFile(novaDirectory, fileName)
        val descriptor = ParcelFileDescriptor.open(
            file,
            ParcelFileDescriptor.MODE_CREATE
                or ParcelFileDescriptor.MODE_READ_WRITE
                or ParcelFileDescriptor.MODE_TRUNCATE,
        )
        return NativeDestination(
            uri = Uri.fromFile(file),
            descriptor = descriptor,
            publishOnComplete = false,
        )
    }

    private fun uniqueFile(directory: File, fileName: String): File {
        val direct = File(directory, fileName)
        if (!direct.exists()) return direct

        val dot = fileName.lastIndexOf('.')
        val stem = if (dot > 0) fileName.substring(0, dot) else fileName
        val extension = if (dot > 0) fileName.substring(dot) else ""
        for (index in 1..9999) {
            val candidate = File(directory, "$stem ($index)$extension")
            if (!candidate.exists()) return candidate
        }
        error("NOVA could not allocate a unique download name")
    }
}
