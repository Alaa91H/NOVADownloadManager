package com.nova.downloadmanager.core

/**
 * Minimal bootstrap boundary for the packaged NOVA Rust core.
 *
 * Android must establish this compatibility handshake before it accepts a
 * transfer. This intentionally fails closed: a missing native library or ABI
 * mismatch is a packaging/build error, not permission to silently run a second
 * Kotlin download engine.
 */
internal object NovaNativeCore {
    private const val LIBRARY_NAME = "nova_mobile_ffi"
    private const val CLIENT_BRIDGE_API_VERSION = 2
    private const val RESUME_APPEND = 0
    private const val RESUME_RESTART = 1
    private const val MISSING_CONTENT_RANGE = -1L
    private const val NATIVE_TRANSFER_PAUSED = -2L
    private const val NATIVE_TRANSFER_CANCELLED = -3L

    internal data class ByteRange(
        val start: Long,
        val end: Long,
    ) {
        init {
            require(start >= 0) { "start must be non-negative" }
            require(end >= start) { "end must not precede start" }
        }

        val length: Long
            get() = end - start + 1
    }

    internal enum class ResumeAction {
        APPEND,
        RESTART,
    }

    internal enum class NativeTransferStatus {
        COMPLETED,
        PAUSED,
        CANCELLED,
    }

    internal data class NativeTransferOutcome(
        val status: NativeTransferStatus,
        val finalBytes: Long,
    )


    internal data class NativeTransferProgress(
        val downloadedBytes: Long,
        val totalBytes: Long,
    )

    private val loadFailure: Throwable? = runCatching {
        System.loadLibrary(LIBRARY_NAME)
    }.exceptionOrNull()

    private external fun nativeInitialize(clientBridgeApiVersion: Int): Int

    private external fun nativePlanSegmentCount(
        totalBytes: Long,
        requestedConnections: Int,
    ): Int

    private external fun nativePlanSegmentStart(
        totalBytes: Long,
        requestedConnections: Int,
        segmentIndex: Int,
    ): Long

    private external fun nativePlanSegmentEnd(
        totalBytes: Long,
        requestedConnections: Int,
        segmentIndex: Int,
    ): Long

    private external fun nativePlanHttpResume(
        existingBytes: Long,
        responseStatus: Int,
        contentRangeStart: Long,
    ): Int

    private external fun nativeDownloadToAppPrivate(
        taskId: String,
        url: String,
        appPrivateRoot: String,
        relativeDestination: String,
    ): Long

    private external fun nativePauseTransfer(taskId: String): Boolean

    private external fun nativeCancelTransfer(taskId: String): Boolean

    private external fun nativeTransferDownloadedBytes(taskId: String): Long

    private external fun nativeTransferTotalBytes(taskId: String): Long

    private external fun nativeForgetTransferProgress(taskId: String)

    private external fun nativeDiscardAppPrivateTransfer(
        appPrivateRoot: String,
        relativeDestination: String,
    ): Boolean

    fun requireCompatible(): Int {
        loadFailure?.let { failure ->
            throw IllegalStateException(
                "NOVA native core is unavailable; the APK is missing a compatible $LIBRARY_NAME library",
                failure,
            )
        }

        val coreBridgeVersion = runCatching {
            nativeInitialize(CLIENT_BRIDGE_API_VERSION)
        }.getOrElse { failure ->
            throw IllegalStateException("NOVA native core handshake failed", failure)
        }

        check(coreBridgeVersion == CLIENT_BRIDGE_API_VERSION) {
            "NOVA native core bridge mismatch: Android expects $CLIENT_BRIDGE_API_VERSION but core returned $coreBridgeVersion"
        }
        return coreBridgeVersion
    }

    /**
     * Returns the shared NOVA byte-range plan for a known representation size.
     *
     * Android lifecycle/transport code may request lower parallelism for power
     * or network policy, but range boundaries come from Rust so mobile cannot
     * drift from the desktop engine's segmentation semantics.
     */
    fun planTransferRanges(
        totalBytes: Long,
        requestedConnections: Int,
    ): List<ByteRange> {
        require(totalBytes >= 0) { "totalBytes must be non-negative" }
        require(requestedConnections >= 0) { "requestedConnections must be non-negative" }
        requireCompatible()

        val segmentCount = nativePlanSegmentCount(totalBytes, requestedConnections)
        check(segmentCount >= 0) { "NOVA native core rejected segment planning inputs" }

        return List(segmentCount) { index ->
            val start = nativePlanSegmentStart(totalBytes, requestedConnections, index)
            val end = nativePlanSegmentEnd(totalBytes, requestedConnections, index)
            check(start >= 0 && end >= start) {
                "NOVA native core returned an invalid segment range at index $index"
            }
            ByteRange(start, end)
        }
    }

    /**
     * Applies the shared NOVA resume policy. Android transport code must use
     * this decision before appending bytes from a ranged HTTP response.
     */
    fun planHttpResume(
        existingBytes: Long,
        responseStatus: Int,
        contentRangeStart: Long?,
    ): ResumeAction {
        require(existingBytes >= 0) { "existingBytes must be non-negative" }
        require(responseStatus in 0..65_535) { "responseStatus must fit the native HTTP status representation" }
        require(contentRangeStart == null || contentRangeStart >= 0) {
            "contentRangeStart must be non-negative when present"
        }
        requireCompatible()

        return when (
            nativePlanHttpResume(
                existingBytes,
                responseStatus,
                contentRangeStart ?: MISSING_CONTENT_RANGE,
            )
        ) {
            RESUME_APPEND -> ResumeAction.APPEND
            RESUME_RESTART -> ResumeAction.RESTART
            else -> error("NOVA native core rejected resume planning inputs")
        }
    }

    /**
     * Runs one direct transfer entirely through the shared Rust core.
     *
     * The destination is constrained by Rust to a path relative to Android's
     * app-private files root. Public storage is intentionally not exposed here.
     */
    fun downloadToAppPrivate(
        taskId: String,
        url: String,
        appPrivateRoot: String,
        relativeDestination: String,
    ): NativeTransferOutcome {
        requireCompatible()
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        require(relativeDestination.isNotBlank()) { "relativeDestination must not be blank" }

        return when (
            val result = nativeDownloadToAppPrivate(
                taskId,
                url,
                appPrivateRoot,
                relativeDestination,
            )
        ) {
            NATIVE_TRANSFER_PAUSED -> NativeTransferOutcome(NativeTransferStatus.PAUSED, 0)
            NATIVE_TRANSFER_CANCELLED -> NativeTransferOutcome(NativeTransferStatus.CANCELLED, 0)
            else -> {
                check(result >= 0) { "NOVA native app-private transfer failed" }
                NativeTransferOutcome(NativeTransferStatus.COMPLETED, result)
            }
        }
    }

    fun pauseTransfer(taskId: String): Boolean {
        requireCompatible()
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        return nativePauseTransfer(taskId)
    }

    fun cancelTransfer(taskId: String): Boolean {
        requireCompatible()
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        return nativeCancelTransfer(taskId)
    }

    fun transferProgress(taskId: String): NativeTransferProgress? {
        requireCompatible()
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        val downloaded = nativeTransferDownloadedBytes(taskId)
        val total = nativeTransferTotalBytes(taskId)
        if (downloaded < 0 || total < 0) return null
        return NativeTransferProgress(
            downloadedBytes = downloaded,
            totalBytes = total,
        )
    }

    fun forgetTransferProgress(taskId: String) {
        requireCompatible()
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        nativeForgetTransferProgress(taskId)
    }

    fun discardAppPrivateTransfer(
        appPrivateRoot: String,
        relativeDestination: String,
    ): Boolean {
        requireCompatible()
        require(relativeDestination.isNotBlank()) { "relativeDestination must not be blank" }
        return nativeDiscardAppPrivateTransfer(appPrivateRoot, relativeDestination)
    }
}
