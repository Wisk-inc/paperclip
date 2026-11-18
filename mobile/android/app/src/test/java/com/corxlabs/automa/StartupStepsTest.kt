package com.corxlabs.automa

import org.junit.Assert.assertEquals
import org.junit.Test

class StartupStepsTest {
    private val labels = arrayOf("Checking assigned tasks", "Starting plugins")

    @Test
    fun showsTheStepInTheAppsLanguage() {
        val spanish = arrayOf("comprobando las tareas asignadas", "iniciando los complementos")
        assertEquals("comprobando las tareas asignadas", StartupSteps.name("Checking assigned tasks", labels, spanish))
        assertEquals("iniciando los complementos", StartupSteps.name("Starting plugins", labels, spanish))
    }

    @Test
    fun aStepTheAppDoesNotKnowReadsInEnglishAsInASentence() {
        val spanish = arrayOf("comprobando las tareas asignadas", "iniciando los complementos")
        assertEquals("warming up the cache", StartupSteps.name("Warming up the cache", labels, spanish))
        // A language file missing a name (never written that way, but safe).
        assertEquals("starting plugins", StartupSteps.name("Starting plugins", labels, arrayOf("comprobando las tareas asignadas")))
    }
}
