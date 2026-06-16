# Weather code reference

This file is mounted into the default sandbox at `/workspace/weather-codes.md`
via the `agent/sandbox/workspace/` convention. The framework
copies it into the sandbox at session bootstrap so the model can read it
through the framework `bash` tool without making a network request.

| Code | Description       |
| ---- | ----------------- |
| 0    | Clear sky         |
| 1    | Mainly clear      |
| 2    | Partly cloudy     |
| 3    | Overcast          |
| 45   | Fog               |
| 48   | Rime fog          |
| 51   | Light drizzle     |
| 53   | Moderate drizzle  |
| 55   | Dense drizzle     |
| 61   | Slight rain       |
| 63   | Moderate rain     |
| 65   | Heavy rain        |
| 71   | Slight snow       |
| 73   | Moderate snow     |
| 75   | Heavy snow        |
| 80   | Slight rain show. |
| 95   | Thunderstorm      |
