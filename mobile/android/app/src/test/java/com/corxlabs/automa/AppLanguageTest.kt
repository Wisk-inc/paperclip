package com.corxlabs.automa

import org.junit.Assert.assertEquals
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
