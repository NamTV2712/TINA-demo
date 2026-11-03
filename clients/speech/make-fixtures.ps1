param([string]$OutputDirectory = "output/speech-stage2/fixtures")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$fixtureDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    # Synthetic ENGLISH KWS fixtures only; this does not change TINA's shared TTS voice.
    $synth.SelectVoice("Microsoft Zira Desktop")
    foreach ($name in @("hey-tina", "negative")) {
        $prompt = New-Object System.Speech.Synthesis.PromptBuilder
        $prompt.AppendBreak([TimeSpan]::FromSeconds(1))
        if ($name -eq "hey-tina") {
            foreach ($attempt in 1..3) {
                $prompt.AppendText("Hey Tina.")
                $prompt.AppendBreak([TimeSpan]::FromSeconds(3))
            }
        } else {
            foreach ($phrase in @("Hey Nina.", "Hey Gina.", "Hey Tim.",
                "The meeting starts at nine.", "Please read the document.", "Thank you.")) {
                $prompt.AppendText($phrase)
                $prompt.AppendBreak([TimeSpan]::FromSeconds(2))
            }
        }
        $synth.SetOutputToWaveFile((Join-Path $fixtureDirectory "$name.wav"), $format)
        $synth.Speak($prompt)
        $synth.SetOutputToNull()
    }
} finally {
    $synth.Dispose()
}
Write-Output "Synthetic fixtures saved to $fixtureDirectory (not human validation)."
