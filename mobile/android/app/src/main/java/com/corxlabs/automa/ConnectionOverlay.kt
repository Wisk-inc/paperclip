package com.corxlabs.automa

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.os.CountDownTimer
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/**
 * The native sheet shown over the board when the phone has no network, or
 * when the Automa server does not answer: the page underneath stays as it
 * was, so nothing typed is lost, and a bar fills up to the next try (no
 * seconds to count) instead of leaving a dead white page. A server on this
 * phone shows it only while Automa answers that it is still starting; once it
 * stops answering at all, the connect screen waits for Termux instead (see
 * MainActivity).
 */
class ConnectionOverlay(
    context: Context,
    private val onRetry: () -> Unit,
    /** The connect screen, for a server that is gone for good: retrying alone was a dead end. */
    private val onOtherServer: () -> Unit,
) : FrameLayout(context) {
    /** STARTING: Automa on this phone answered that it is still starting; it is checked again by itself. */
    enum class Reason { OFFLINE, UNREACHABLE, STARTING }

    var reason: Reason = Reason.OFFLINE
        private set

    private val title = TextView(context)
    private val message = TextView(context)
    private val countdown = TextView(context)
    private val progress = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal)
    private val retry = Button(context)
    private val otherServer = Button(context)
    private var timer: CountDownTimer? = null

    init {
        setBackgroundColor(Color.argb(242, 0, 0, 0))
        isClickable = true
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val pad = dp(28)
            setPadding(pad, pad, pad, pad)
        }
        title.apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        message.apply {
            setTextColor(Color.argb(200, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            setPadding(0, dp(10), 0, 0)
        }
        countdown.apply {
            setTextColor(Color.argb(160, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, 0)
        }
        progress.apply {
            max = PROGRESS_STEPS
            progressTintList = ColorStateList.valueOf(Color.WHITE)
            progressBackgroundTintList = ColorStateList.valueOf(Color.argb(60, 255, 255, 255))
            isIndeterminate = false
        }
        retry.apply {
            text = context.getString(R.string.offline_retry)
            setOnClickListener { timer?.cancel(); onRetry() }
            setPadding(dp(24), dp(12), dp(24), dp(12))
        }
        otherServer.apply {
            text = context.getString(R.string.offline_other_server)
            setOnClickListener { timer?.cancel(); onOtherServer() }
            setPadding(dp(24), dp(12), dp(24), dp(12))
            isAllCaps = false
            setBackgroundColor(Color.TRANSPARENT)
            setTextColor(Color.argb(200, 255, 255, 255))
        }
        column.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(
            progress,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6)).apply { topMargin = dp(22) },
        )
        column.addView(countdown, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        column.addView(
            retry,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(22) },
        )
        column.addView(
            otherServer,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) },
        )
        addView(column, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    /** Shows the sheet; with [retryInSeconds] > 0 a bar fills up and it retries by itself when full. */
    fun show(reason: Reason, detail: String?, retryInSeconds: Int) {
        this.reason = reason
        timer?.cancel()
        val res = context.resources
        when (reason) {
            Reason.OFFLINE -> {
                title.text = res.getString(R.string.offline_title)
                message.text = res.getString(R.string.offline_message)
                countdown.text = res.getString(R.string.offline_waiting)
                // Waiting on the network, not a timer: the bar keeps moving.
                progress.isIndeterminate = true
            }
            Reason.UNREACHABLE -> {
                title.text = res.getString(R.string.unreachable_title)
                message.text = listOfNotNull(res.getString(R.string.unreachable_message), detail).joinToString("\n\n")
            }
            Reason.STARTING -> {
                title.text = res.getString(R.string.starting_title)
                message.text = res.getString(R.string.starting_message)
                countdown.text = res.getString(R.string.starting_waiting)
                // Checked again by MainActivity on its own schedule: the bar keeps moving.
                progress.isIndeterminate = true
            }
        }
        if (retryInSeconds > 0) {
            val total = retryInSeconds * 1000L
            progress.isIndeterminate = false
            progress.progress = 0
            countdown.text = res.getString(R.string.reconnecting_soon)
            timer = object : CountDownTimer(total, 50L) {
                override fun onTick(millisUntilFinished: Long) {
                    progress.progress = (((total - millisUntilFinished) * PROGRESS_STEPS) / total).toInt()
                }
                override fun onFinish() {
                    progress.progress = PROGRESS_STEPS
                    progress.isIndeterminate = true
                    countdown.text = res.getString(R.string.retrying_now)
                    onRetry()
                }
            }.start()
        }
    }

    override fun onDetachedFromWindow() {
        timer?.cancel()
        timer = null
        super.onDetachedFromWindow()
    }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).toInt()

    private companion object {
        const val PROGRESS_STEPS = 1000
    }
}
