package com.corxlabs.automa

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board tells the app the person's language choice through the bridge.
 * Only "auto" and the 40 languages Automa's screens come in are kept; a page
 * cannot make the app save anything else.
 */
class AppLanguageTest {
    @Test
    fun keepsAutoAndEveryLanguageAutomaComesIn() {
        assertEquals(AppLanguage.AUTO, AppLanguage.normalize("auto"))
        assertEquals(40, AppLanguage.CODES.size)
        assertTrue("en" in AppLanguage.CODES)
        for (code in AppLanguage.CODES) assertEquals(code, AppLanguage.normalize(code))
        // Surrounding spaces are not part of the choice.
        assertEquals("pt-BR", AppLanguage.normalize(" pt-BR "))
    }

    private class FakeTarget : AppLanguage.Target {
        override var saved: String = AppLanguage.AUTO
        val applied = mutableListOf<String>()
        override fun apply(choice: String) {
            applied += choice
        }
    }

    @Test
    fun appliesOnlyANewChoice() {
        val target = FakeTarget()
        assertTrue(AppLanguage.choose(target, "es"))
        assertEquals("es", target.saved)
        assertEquals(listOf("es"), target.applied)
        // The board repeats its choice each time it opens: nothing is applied again,
        // so a language picked in Android's settings meanwhile is not put back.
        assertFalse(AppLanguage.choose(target, "es"))
        assertEquals(listOf("es"), target.applied)
        // A new choice, Auto included, is kept and applied.
        assertTrue(AppLanguage.choose(target, "auto"))
        assertEquals(AppLanguage.AUTO, target.saved)
        assertEquals(listOf("es", "auto"), target.applied)
        // Anything else changes nothing.
        assertFalse(AppLanguage.choose(target, "klingon"))
        assertFalse(AppLanguage.choose(target, null))
        assertEquals(AppLanguage.AUTO, target.saved)
        assertEquals(listOf("es", "auto"), target.applied)
    }

    @Test
    fun refusesAnythingElse() {
        assertNull(AppLanguage.normalize(null))
        assertNull(AppLanguage.normalize(""))
        assertNull(AppLanguage.normalize("klingon"))
        // Codes are exactly the board's: no other spelling or a bare "pt"/"zh".
        assertNull(AppLanguage.normalize("FR"))
        assertNull(AppLanguage.normalize("pt"))
        assertNull(AppLanguage.normalize("zh"))
        assertNull(AppLanguage.normalize("zh_CN"))
        assertNull(AppLanguage.normalize("auto; rm -rf /"))
    }
}
