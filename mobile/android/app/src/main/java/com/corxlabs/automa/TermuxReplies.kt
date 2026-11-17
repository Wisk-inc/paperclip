package com.corxlabs.automa

import java.util.concurrent.atomic.AtomicInteger

/**
 * Where Termux sends the answer to one RUN_COMMAND (Start, Safe start,
 * Troubleshoot): it answers through the PendingIntent it was given, as a
 * broadcast. Each request gets its own action, so only the request that asked
 * hears the answer. With one action shared by all of them, two requests in
 * flight (Automa starting while Troubleshoot runs) both took the first answer:
 * Troubleshoot showed `automa start`'s output as its report, and its own report
 * then reached no one.
 */
internal object TermuxReplies {
    /** For the whole app process, so a request made after the activity is recreated never reuses a number. */
    private val next = AtomicInteger()

    /** One request: its PendingIntent request code, and the broadcast action its answer comes back on. */
    class Request(val code: Int, val action: String)

    fun newRequest(packageName: String): Request {
        val code = next.incrementAndGet()
        return Request(code, "$packageName.TERMUX_RESULT.$code")
    }
}
