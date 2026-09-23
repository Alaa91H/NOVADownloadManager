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
    private const val CLIENT_BRIDGE_API_VERSION = 1
    private const val RESUME_APPEND = 0
    private const val RESUME_RESTART = 1
    private const val MISSING_CONTENT_RANGE = -1L

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

    internal data class HttpResourceProbe(
        val responseStatus: Int,
        val contentLength: Long?,
    )

    private val loadFailure: Throwable? = runCatching {
        System.loadLibrary(LIBRARY_NAME)
    }.exceptionOrNull()

    private external fun nativeInitialize(clientBridgeApiVersion: Int): Int

    private external fun nativeProbeHttpResource(url: String): LongArray?

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
     * Runs HTTP metadata discovery through NOVA's packaged Rust/libcurl core.
     *
     * Callers must execute this on a background dispatcher because it performs
     * bounded network I/O. A transport failure fails closed; Android must not
     * silently repeat the request through a second HTTP client.
     */
    fun probeHttpResource(url: String): HttpResourceProbe {
        require(url.isNotBlank()) { "url must not be blank" }
        requireCompatible()

        val values = runCatching { nativeProbeHttpResource(url) }
            .getOrElse { failure ->
                throw IllegalStateException("NOVA native HTTP preflight failed", failure)
            }
            ?: throw IllegalStateException("NOVA native HTTP preflight returned no result")
        check(values.size == 2) {
            "NOVA native HTTP preflight returned an invalid result shape"
        }

        val status = values[0]
        check(status in 100L..599L) {
            "NOVA native HTTP preflight returned an invalid HTTP status: $status"
        }
        val contentLength = values[1]
        check(contentLength >= -1L) {
            "NOVA native HTTP preflight returned an invalid content length: $contentLength"
        }

        return HttpResourceProbe(
            responseStatus = status.toInt(),
            contentLength = contentLength.takeIf { it >= 0L },
        )
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
}
