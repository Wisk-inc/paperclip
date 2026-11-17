package com.corxlabs.automa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Each Termux request (Start, Safe start, Troubleshoot) must hear only its own
 * answer: Android delivers a broadcast to every receiver registered for its
 * action, so two requests in flight need two actions.
 */
class TermuxRepliesTest {
    @Test
    fun eachRequestHasItsOwnReplyActionAndRequestCode() {
        val requests = List(100) { TermuxReplies.newRequest("com.corxlabs.automa") }
        assertEquals(100, requests.map { it.action }.toSet().size)
        assertEquals(100, requests.map { it.code }.toSet().size)
        for (request in requests) {
            // Delivered to this app only (the reply intent is also set to this package).
            assertTrue(request.action, request.action.startsWith("com.corxlabs.automa.TERMUX_RESULT."))
            assertTrue(request.action, request.action.endsWith(".${request.code}"))
        }
    }

    @Test
    fun requestsMadeAtTheSameTimeNeverShareAnAction() {
        val threads = 8
        val perThread = 250
        val actions = Collections.synchronizedSet(HashSet<String>())
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(threads)
        repeat(threads) {
            pool.execute {
                start.await()
                repeat(perThread) { actions.add(TermuxReplies.newRequest("com.corxlabs.automa").action) }
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS))
        assertEquals(threads * perThread, actions.size)
    }
}
