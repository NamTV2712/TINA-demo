# Pipeline cuộc họp hiện tại của TINA

Sơ đồ ánh xạ implementation có trong checkout hiện tại. Nó mô tả các đường local Desktop và meeting bot riêng nhau, cùng các bước hậu kỳ tùy chọn.

`◇` là nhánh tùy cấu hình hoặc cần người dùng khởi chạy. Sơ đồ theo source code; chưa xác nhận dịch vụ nào đang chạy trong một deployment cụ thể.

## Capture đến transcript

```mermaid
flowchart TD
  subgraph LOCAL["TINA Desktop / capture tại máy"]
    EXT["Extension hoặc TINA Capture"] --> WS["Ingest WebSocket :9099"]
    WS --> RING["AudioTimelinePool<br/>ring 30 giây mỗi nguồn"]
    RING --> DENG["Desktop engine<br/>gmeet theo channel hoặc mixed lane"]
    RING --> SQLITE["transcripts.sqlite<br/>audio PCM nguồn + ASR gốc"]
  end

  subgraph BOT["Meeting Bot / capture trên trang họp"]
    PAGE["Bot tham gia họp"] --> BRIDGE["Capture bridge<br/>audio + timestamp + tín hiệu danh tính"]
    BRIDGE --> LANE["Meet/Zoom: channel riêng<br/>Teams: CSRC virtual channels<br/>Jitsi: Pyannote cắt lượt + hints"]
    BRIDGE -. "◇ recording.v1" .-> REC["Bản ghi bot, nếu bật"]
  end

  DENG --> WINDOW["Buffer / endpointing theo host<br/>gửi lại cửa sổ audio để xác nhận text"]
  LANE --> WINDOW
  WINDOW --> ASR["ASR qua HTTP đã cấu hình<br/>FunASR Qwen3 + FSMN<br/>hoặc Sherpa Qwen3 + Silero<br/>hoặc endpoint tương thích khác"]
  ASR --> SEG["transcript.v1<br/>draft / confirmed / retract"]

  SEG --> DVIEW["Desktop: live transcript<br/>SQLite + Review UI"]
  SEG --> STREAM["Bot: Redis transcription_segments"]
  STREAM --> COL["Meeting API collector"]
  COL --> PG["Redis phần transcript đang đổi<br/>→ DB writer → Postgres"]
  STREAM --> PUB["Redis live Pub/Sub"]
  COL --> PUB
  PUB --> GW["Gateway /ws → Dashboard"]

  STREAM --> WATCH["Agent watcher"]
  COL --> FEED["tc:meeting:{row_id}"]
  WATCH -->|"◇ proc flag được bật"| COPILOT["Copilot chạy trong runtime cô lập"]
  FEED --> COPILOT
  COPILOT --> CARDS["Processed notes + entity cards"]
  CARDS --> TERMINAL["Terminal SSE / workspace"]
```

Desktop có ring buffer 30 giây cho mỗi nguồn và lưu audio PCM cùng transcript gốc vào SQLite. Bot cloud có thể lưu bản ghi riêng nếu bật recording.

Các backend Qwen3 + FSMN-VAD và Qwen3 + Silero-VAD đều có trong source. Chúng nhận các cửa sổ audio qua HTTP, không stream token; TINA tạo draft và final bằng cách gửi lại cửa sổ rồi xác nhận phần text ổn định.

## Speaker, hậu kỳ và meeting memory

```mermaid
flowchart TD
  PG["Postgres transcript rows<br/>raw ASR + canonical revisions"]
  REC["Bản ghi bot đã lưu<br/>nếu recording.v1 được bật"]
  RAW["ASR gốc được giữ nguyên"]

  PG --> RAW
  REC --> DIA["◇ Owner khởi chạy diarization<br/>qua worker bên ngoài"]
  META["Participant ID từ capture<br/>hoặc tên người dùng sửa"] --> REG["Speaker registry theo từng meeting"]
  DIA -->|"Owner Apply"| REG

  RAW --> ALIGN["◇ Vietnamese MFA word alignment<br/>owner khởi chạy, worker đã cấu hình"]
  REC --> ALIGN
  REG --> ATTR["Word-level speaker attribution"]
  DIA --> ATTR
  ALIGN --> ATTR

  PG --> REF["◇ ASR refinement lần hai<br/>tạo đề xuất theo từng đoạn"]
  REC --> REF
  RAW --> CAN["Canonical text<br/>raw hoặc revision đã được áp dụng"]
  REF -->|"Owner Apply"| CAN
  CAN --> OUT["Transcript revision outbox"]
  REG --> OUT
  OUT --> UI["UI nhận transcript/speaker revision"]

  FEED["Transcript stream theo meeting"] --> COP["◇ Copilot opt-in<br/>xử lý cửa sổ transcript theo từng beat"]
  COP --> NOTES["Processed notes + cards<br/>mặc định: person / company / product"]
  NOTES --> SURFACE["Terminal stream / workspace meeting doc"]

  PG --> FTS["Postgres full-text search<br/>lexical"]
  FTS --> SEARCH["Meeting transcript search"]
```

Diarization và alignment là job hậu kỳ trên audio bot đã lưu; refinement cũng tạo đề xuất để người dùng duyệt. Các thay đổi transcript và speaker có revision/outbox. Speaker registry gắn danh tính trong phạm vi từng meeting.

Copilot là nhánh riêng, chỉ được arm khi bật xử lý cho meeting. Cấu hình mặc định tạo notes và entity cards cho person/company/product; chưa mặc định trích xuất actions, decisions hoặc facts. Tìm transcript hiện dùng Postgres full-text search; source chưa nối `pgvector` hoặc hybrid vector + lexical retrieval.

Desktop local có Review UI và job ASR refinement lần hai. README của Desktop ghi rõ nhánh này chưa thêm word alignment hoặc diarization.

## Implementation pointers

- Audio ring và source timeline: `core/meetings/modules/buffer/src/audio-ring.ts`
- Desktop capture, SQLite archive và Review: `core/meetings/services/desktop/README.md`
- FunASR Qwen3 + FSMN-VAD: `deploy/transcription/funasr/README.md`
- Sherpa Qwen3 + Silero-VAD: `core/meetings/services/native-asr/README.md`
- Bot lane routing: `core/meetings/services/bot/src/pipeline.ts`
- Speaker registry, diarization, alignment, refinement: `core/meetings/services/meeting-api/src/meeting_api/collector/`
- Copilot defaults: `core/agent/workspace-seeds/default/agents/meeting.md`
- Transcript search contract: `core/meetings/services/meeting-api/src/meeting_api/collector/ports.py`
