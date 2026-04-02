package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	recalltypes "recall-events-engine/customtypes"

	"github.com/go-co-op/gocron/v2"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	//_ "github.com/mattn/go-sqlite3"
	_ "github.com/lib/pq"
)

var db *sql.DB
func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(`
	CREATE TABLE IF NOT EXISTS scheduled_jobs (
		id TEXT PRIMARY KEY,
		name TEXT,
		meeting_url TEXT,
		agent_email_id TEXT,
		cron TEXT,
		expiry TEXT,
		status TEXT,
		created_at TEXT,
		uid TEXT,
		start_time TEXT
	);`)
	
		return err
	}

	



// Method to Get all Jobs from Database (optionally filtered by agent email IDs)
func GetAllJobsFromDB(agentEmailIDs []string) ([]ScheduledJob, error) {
	
	// Base query
	sqlStmt := `
		SELECT id, name, cron, agent_email_id, meeting_url, expiry, status, COALESCE(uid,''), COALESCE(start_time,''), COALESCE(created_at,'')
    
		FROM scheduled_jobs
	`

	var args []interface{}

	// If filter values are provided, add WHERE clause
	if len(agentEmailIDs) > 0 {
		placeholders := make([]string, len(agentEmailIDs)) //placeholders $ for postgres
		for i, id := range agentEmailIDs {
			placeholders[i] = fmt.Sprintf("$%d", i+1)
			args = append(args, id)
		}

		sqlStmt += " WHERE agent_email_id IN (" + strings.Join(placeholders, ", ") + ")"
		
	}

	res, err := db.Query(sqlStmt, args...)
	if err != nil {
		return []ScheduledJob{}, err
	}
	defer res.Close()

	var scheduledJobsFromDB []ScheduledJob = []ScheduledJob{}

	for res.Next() {
		var job ScheduledJob
		err := res.Scan(
			&job.ID,
			&job.Name,
			&job.Cron,
			&job.AgentEmailID,
			&job.MeetingURL,
			&job.Expiry,
			&job.Status,
			&job.UID,
			&job.StartTime,
			&job.CreatedAt,
		)
		if err != nil {
			return []ScheduledJob{}, err
		}
		scheduledJobsFromDB = append(scheduledJobsFromDB, job)
	}

	if err = res.Err(); err != nil {
		return []ScheduledJob{}, err
	}

	return scheduledJobsFromDB, nil
}

// Method to Add new Job to Database
func AddJobToDB(job ScheduledJob) error {
	

	sqlStmt := `
	INSERT INTO scheduled_jobs (id, name, cron, agent_email_id, meeting_url, expiry, status, uid, start_time, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
	`

	_, err := db.Exec(sqlStmt, job.ID, job.Name, job.Cron, job.AgentEmailID, job.MeetingURL, job.Expiry, job.Status, job.UID, job.StartTime, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return err
	}
	return nil
}

// Method to Get Job from Database by ID
func GetJobFromDBByID(jobID string) (ScheduledJob, error) {
	

	sqlStmt := `
	SELECT id, name, cron, agent_email_id, meeting_url, expiry
	FROM scheduled_jobs WHERE id = $1;
	`

	row := db.QueryRow(sqlStmt, jobID)

	var job ScheduledJob
	err := row.Scan(&job.ID, &job.Name, &job.Cron, &job.AgentEmailID, &job.MeetingURL, &job.Expiry)
	if err != nil {
		if err == sql.ErrNoRows {
			return ScheduledJob{}, nil // No record found
		}
		return ScheduledJob{}, err
	}

	return job, nil
}

// Method to Delete Job from Database by ID
func DeleteJobFromDBByID(jobID string) error {

	
	sqlStmt := `
	DELETE FROM scheduled_jobs WHERE id = $1;
	`
	_, err := db.Exec(sqlStmt, jobID)
	if err != nil {
		return err
	}
	return nil
}

// Method to Update Job Status in Database
func UpdateJobStatusInDB(jobID string, status string) error {
	

	sqlStmt := `
	UPDATE scheduled_jobs
	SET status = $1
	WHERE id = $2;
	`

	_, err := db.Exec(sqlStmt, status, jobID)
	if err != nil {
		return err
	}
	return nil
}

// Method to extract meeting info from email body
const systemPrompt = `
You are an expert calendar extraction engine.

Your task is to extract or infer meeting events from raw email content.

The input may be:
- a raw .ics calendar file
- a plain-text meeting email
- a forwarded email chain
- a reply
- mixed or noisy content

The input is the sole source of factual data.
You must NOT invent facts that are not supported by the input.

IMPORTANT DISTINCTION:
- You ARE allowed to apply rule-based inference.
- You are NOT allowed to freely guess or hallucinate.

Think in two phases:
1. Evidence extraction (times, people, links, wording)
2. Event construction using the inference rules below

Your job:
- Determine whether the content represents:
  - a meeting creation (scheduled for the future, or happening right now)
  - a meeting update
  - a meeting cancellation
  - or no meeting

- IF SEQUENCE is greater than 0 (e.g. SEQUENCE:1) consider that event as an update event. This is your highest priority check.

- IMPORTANT: If the email subject or body contains phrases like "happening now", "inviting you to join a video call", "join now", or similar — treat it as event_type "create" with start_time_utc set to null. The agent should join immediately.

- Resolve the FINAL intended state of the meeting.
- Prefer the most recent information if conflicts exist.
- Ignore signatures, disclaimers, and quoted history unless relevant.
- Leave the "cron" field as null always. The schedule is derived from start_time_utc. If the ICS contains an RRULE field, copy it verbatim into the "rrule" field (e.g. "FREQ=DAILY;BYHOUR=20;BYMINUTE=0"). If there is no recurrence, set "rrule" to null.
- Notes field should be a short summary of the contents of the mail and things present in "DESCRIPTION" and can contain important things such as passwords required to join .
- Give only the json expected and nothing else apart from it , no justification , no explaining how you got there.

- If multiple ICS attachments are present with the same UID, treat them as the same event and ignore duplicates.
- If multiple ICS attachments are present with different UID  , display them in different sets.

TIMEZONE CONVERSION RULES — CRITICAL, READ CAREFULLY:
You must convert all local times to UTC before writing start_time_utc and end_time_utc.
The output format must be RFC3339 UTC, ending in "Z" (e.g. "2026-02-27T10:48:00Z").

Common timezone offsets — memorise these exactly:
- TZID=Asia/Kolkata or IST  → UTC+5:30  (subtract 5 hours AND 30 minutes from local time)
- TZID=America/New_York EST → UTC-5:00  (add 5 hours)
- TZID=America/New_York EDT → UTC-4:00  (add 4 hours)
- TZID=America/Los_Angeles PST → UTC-8:00
- TZID=America/Los_Angeles PDT → UTC-7:00
- TZID=Europe/London GMT   → UTC+0:00
- TZID=Europe/London BST   → UTC+1:00
- TZID=Europe/Paris CET    → UTC+1:00
- TZID=Europe/Paris CEST   → UTC+2:00

WORKED EXAMPLE (IST, the most common error):
  Input:  DTSTART;TZID=Asia/Kolkata:20260227T161800
  Local time: 16:18 IST
  IST offset: +5:30 (five hours AND thirty minutes)
  UTC = 16:18 - 5:30 = 10:48
  Output: "start_time_utc": "2026-02-27T10:48:00Z"   ← CORRECT
  WRONG:  "start_time_utc": "2026-02-27T11:18:00Z"   ← this subtracts only 5h, missing the :30

If the DTSTART already ends in Z (e.g. DTSTART:20260227T104800Z), it is already UTC — use it as-is.

INFERENCE RULE FOR PLAIN TEXT EMAILS:

If ALL of the following are present:
- a clear start time
- a clear end time
- a sender email
- at least one recipient email

Then treat the content as a meeting creation,
EVEN IF:
- there is no meeting link yet
- there is no UID
- the word "meeting" is not explicitly used

This represents an implicit meeting proposal.
`
const userPromptTemplate = `
Extract meeting information from the following content.

Return a SINGLE JSON object matching this schema exactly:

{
  "event_type": "create | update | cancel | none",
  "uid": "string | null",
  "title": "string | null",
  "start_time_utc": "RFC3339 | null",
  "end_time_utc": "RFC3339 | null",
  "rrule": "string | null",
  "meeting_provider": "google_meet | zoom | teams | unknown | null",
  "meeting_link": "string | null",
  "organizer_email": "string | null",
  "attendees": ["email"],
  "notes": "string | null"
}

Content:
<<<
{{CONTENT}}
>>>
`
type WebhookPayload struct {
	EventType string  `json:"event_type"`
	EventID   string  `json:"event_id"`
	Message   Message `json:"message"`
}

type Message struct {
	From        []string     `json:"from_"`
	To          []string     `json:"to"`
	CC          []string     `json:"cc"`
	BCC         []string     `json:"bcc"`
	Subject     string       `json:"subject"`
	Preview     string       `json:"preview"`
	Text        string       `json:"text"`
	HTML        string       `json:"html"`
	Attachments []Attachment `json:"attachments"`
}

type Attachment struct {
	Filename      string `json:"filename"`
	ContentBase64 string `json:"content_base64"`
	URL            string `json:"url"`
}


func normalize(input string) string {
	s := strings.ReplaceAll(input, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\t' || r >= 32 {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

func htmlToText(html string) string {
	var b strings.Builder
	inTag := false
	for _, r := range html {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			b.WriteRune(r)
		}
	}
	out := b.String()
	out = strings.ReplaceAll(out, "&nbsp;", " ")
	out = strings.ReplaceAll(out, "&amp;", "&")
	return out
}

/* MIME NORMALIZER*/

type ExtractedParts struct {
	Calendar string
	Plain    string
	HTML     string
}
//  parses the DTSTART line directly from the ICS/email content and converts it to UTC using known timezone offsets
func extractUTCFromICS(content string) (string, bool) {
    // timezone offset map 
    tzOffsets := map[string]int{
        "Asia/Kolkata":          330,  
        "Asia/Calcutta":         330,  
        "IST":                   330,
        "America/New_York":      -300, 
        "America/Chicago":       -360,
        "America/Denver":        -420,
        "America/Los_Angeles":   -480,
        "America/Phoenix":       -420,
        "Europe/London":         0,
        "Europe/Paris":          60,
        "Europe/Berlin":         60,
        "Asia/Tokyo":            540,
        "Asia/Shanghai":         480,
        "Asia/Singapore":        480,
        "Australia/Sydney":      600,
        "Pacific/Auckland":      720,
    }

    // Match: DTSTART;TZID=Asia
    re := regexp.MustCompile(`(?i)DTSTART;TZID=([^:\r\n]+):(\d{8}T\d{6})`)
    m := re.FindStringSubmatch(content)
    if m == nil {        
        reUtc := regexp.MustCompile(`(?i)DTSTART:(\d{8}T\d{6}Z)`)
        mu := reUtc.FindStringSubmatch(content)
        if mu != nil {
            t, err := time.Parse("20060102T150405Z", mu[1])
            if err == nil {
                return t.UTC().Format(time.RFC3339), true
            }
        }
        return "", false
    }

    tzName := strings.TrimSpace(m[1])
    localStr := m[2] 

    offsetMins, ok := tzOffsets[tzName]
    if !ok {
        log.Printf("[extractUTCFromICS] Unknown TZID=%q — cannot correct", tzName)
        return "", false
    }

    localTime, err := time.Parse("20060102T150405", localStr)
    if err != nil {
        log.Printf("[extractUTCFromICS] Could not parse local time %q: %v", localStr, err)
        return "", false
    }

    // Convert to UTC
    utc := localTime.Add(-time.Duration(offsetMins) * time.Minute)
    return utc.UTC().Format(time.RFC3339), true
}

func reduceICSForLLM(ics string) string {
	lines := strings.Split(ics, "\n")

	allowedPrefixes := []string{
		"UID:",
		"SEQUENCE:",
		"SUMMARY",
		"DTSTART",
		"DTEND",
		"RRULE:",
		"STATUS:",
		"ORGANIZER",
		"ATTENDEE",
		"LOCATION",
		"DESCRIPTION",
		"X-MICROSOFT-SKYPETEAMSMEETINGURL",
	}

	var kept []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		for _, p := range allowedPrefixes {
			if strings.HasPrefix(line, p) {
				kept = append(kept, line)
				break
			}
		}
	}

	return strings.Join([]string{
		"BEGIN:VEVENT",
		strings.Join(kept, "\n"),
		"END:VEVENT",
	}, "\n")
}

func BuildLLMPayload(raw []byte) (string, error) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return simpleClean(string(raw)), nil
	}

	subject := msg.Header.Get("Subject")
	from := msg.Header.Get("From")
	to := msg.Header.Get("To")
	date := msg.Header.Get("Date")

	var headerBlock string
	if subject != "" || from != "" {
		headerBlock = fmt.Sprintf("Subject: %s\nFrom: %s\nTo: %s\nDate: %s\n\n", subject, from, to, date)
	}

	parts := &ExtractedParts{}
	if err := walkEntity(msg.Header, msg.Body, parts); err != nil {
		return "", err
	}

	if parts.Calendar != "" {
		return simpleClean(headerBlock + parts.Calendar), nil
	}
	if parts.Plain != "" {
		return simpleClean(headerBlock + normalizeMeetingLinks(parts.Plain)), nil
	}
	if parts.HTML != "" {
		return simpleClean(headerBlock + normalizeMeetingLinks(parts.HTML)), nil
	}

	return "", fmt.Errorf("no usable content")
}

// normalizeMeetingLinks for meeting links without http
func normalizeMeetingLinks(s string) string {
	re := regexp.MustCompile(`(?i)(meet\.google\.com|zoom\.us/j|teams\.microsoft\.com/l/meetup-join|webex\.com/meet)/([A-Za-z0-9/_\-?=&.]+)`)
	return re.ReplaceAllStringFunc(s, func(m string) string {
		if !strings.HasPrefix(strings.ToLower(m), "http") {
			return "https://" + m
		}
		return m
	})
}

func walkEntity(header mail.Header, body io.Reader, parts *ExtractedParts) error {
	mediaType, params, _ := mime.ParseMediaType(header.Get("Content-Type"))

	if strings.HasPrefix(mediaType, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if err := walkEntity(mail.Header(part.Header), part, parts); err != nil {
				return err
			}
		}
		return nil
	}

	data, _ := io.ReadAll(body)
	decoded := decodeIfNeeded(data, header.Get("Content-Transfer-Encoding"))

	if strings.Contains(mediaType, "text/calendar") || strings.Contains(header.Get("Content-Disposition"), ".ics") {
		if parts.Calendar == "" {
			parts.Calendar = decoded
		}
	}
	if strings.Contains(mediaType, "text/plain") && parts.Plain == "" {
		parts.Plain = decoded
	}
	if strings.Contains(mediaType, "text/html") && parts.HTML == "" {
		parts.HTML = stripHTML(decoded)
	}
	return nil
}

func decodeIfNeeded(data []byte, encoding string) string {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(string(data), "\n", ""))
		if err == nil {
			return string(decoded)
		}
	case "quoted-printable":
		return decodeQuotedPrintable(string(data))
	}
	return string(data)
}

func stripHTML(s string) string {
	s = decodeQuotedPrintable(s)
	hrefRe := regexp.MustCompile(`(?i)href=["']([^"']+)["']`)
	var links []string
	for _, m := range hrefRe.FindAllStringSubmatch(s, -1) {
		href := m[1]
		if strings.Contains(href, "meet.google.com") ||
			strings.Contains(href, "zoom.us") ||
			strings.Contains(href, "teams.microsoft.com") ||
			strings.Contains(href, "webex.com") {
			if idx := strings.Index(href, "?"); idx != -1 {
				href = href[:idx]
			}
			links = append(links, href)
		}
	}
	// strip all tags
	tagRe := regexp.MustCompile(`(?is)<[^>]+>`)
	text := tagRe.ReplaceAllString(s, "")
	text = strings.ReplaceAll(text, "&nbsp;", " ")
	text = strings.ReplaceAll(text, "&amp;", "&")
	for _, link := range links {
		if !strings.Contains(text, link) {
			text += "\n" + link
		}
	}
	return text
}
func decodeQuotedPrintable(s string) string {
	s = strings.ReplaceAll(s, "=\n", "")
	s = strings.ReplaceAll(s, "=\n", "")
	// Decode common =XX sequences
	qpRe := regexp.MustCompile(`=[0-9A-Fa-f]{2}`)
	s = qpRe.ReplaceAllStringFunc(s, func(match string) string {
		var b byte
		fmt.Sscanf(match[1:], "%02X", &b)
		return string([]byte{b})
	})
	return s
}

func simpleClean(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimSpace(s)
}
// extractRecipientEmail 
func extractRecipientEmail(raw []byte) string {
    msg, err := mail.ReadMessage(bytes.NewReader(raw))
    if err != nil {
        return ""
    }
    // header 
    toHeader := msg.Header.Get("To")
    if toHeader != "" {
        addr, err := mail.ParseAddress(toHeader)
        if err == nil {
            return addr.Address
        }
    }
    delivered := msg.Header.Get("Delivered-To")
    if delivered != "" {
        addr, err := mail.ParseAddress(delivered)
        if err == nil {
            return addr.Address
        }
    }
    // Fall back: for <email@domain>
    re := regexp.MustCompile(`(?i)for\s+<([^>]+)>`)
    m := re.FindSubmatch(raw[:min(len(raw), 4000)])
    if m != nil {
        return string(m[1])
    }
    return ""
}

var groqURL = "https://api.groq.com/openai/v1/chat/completions"

func callGroqLLM(content string) (string, error) {
	log.Printf("[callGroqLLM] Starting LLM call — content length=%d chars", len(content))
	

	apiKey := os.Getenv("LLM_GROQ_API_TOKEN")
	if apiKey == "" {
		return "", fmt.Errorf("GROQ_API_KEY env var not set")
	}
	
	userPrompt := strings.Replace(userPromptTemplate, "{{CONTENT}}", content, 1)

	model := "openai/gpt-oss-120b"

	payload := map[string]interface{}{
		"model":       model,
		"temperature": 0.0,
		"max_tokens":  1024,

		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
	}

	body, _ := json.Marshal(payload)

	req, err := http.NewRequest(
		"POST",
		groqURL,
		bytes.NewBuffer(body),
	)
	if err != nil {
		return "", err
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	


	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	log.Printf("[callGroqLLM] Response status: %d", resp.StatusCode)

	if resp.StatusCode != 200 {
		log.Printf("[callGroqLLM] ERROR: non-200 status — body: %s", string(respBody))
		return "", fmt.Errorf("openrouter error %d: %s", resp.StatusCode, respBody)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
				Reasoning string `json:"reasoning"`

			} `json:"message"`
		} `json:"choices"`
	}

	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", err
	}

	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("no choices returned")
	}

	result := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if result == "" {
    log.Printf("[callGroqLLM] content empty — falling back to reasoning field")
    result = strings.TrimSpace(parsed.Choices[0].Message.Reasoning)
}


	log.Printf("[callGroqLLM] SUCCESS — response length=%d chars", len(result))
	return result, nil
}


	func PostRecallRequest(meetingUrl string, displayName string,cameraURL string, lkRoomID string) (bool, error) {
	
		recallURL := os.Getenv("RECALL_API_URL")
		recallToken := os.Getenv("RECALL_API_TOKEN")
		recallWebhook := os.Getenv("RECALL_WEBHOOK_URL")
	
		log.Printf("[PostRecallRequest] meetingUrl=%s displayName=%s lkRoomID=%s", meetingUrl, displayName, lkRoomID)
	
		if recallURL == "" {
			return false, fmt.Errorf("RECALL_API_URL is not set")
		}
		if recallToken == "" {
			return false, fmt.Errorf("RECALL_API_TOKEN is not set")
		}
		if cameraURL == "" {
		return false, fmt.Errorf("cameraURL is empty")
		}
	
		webhookURL := fmt.Sprintf("%s?room_id=%s", recallWebhook, lkRoomID)
	
		// Build payload
		payload := map[string]interface{}{
			"meeting_url": meetingUrl,
			"bot_name":    displayName,
			"output_media": map[string]interface{}{
				"camera": map[string]interface{}{
					"kind": "webpage",
					"config": map[string]interface{}{
						"url": cameraURL,
					},
				},
			},
			"recording_config": map[string]interface{}{
				"video_mixed_layout": "gallery_view_v2",
				"include_bot_in_recording": map[string]interface{}{
					"audio": true,
				},
				"transcript": map[string]interface{}{
					"provider": map[string]interface{}{
						"deepgram_streaming": map[string]interface{}{
							"model":        "nova-2-meeting",
							"language":     "en-US",
							"smart_format": true,
							"endpointing":  200,
							"numerals":     true,
							"keywords":     []string{"Lisa:2"},
						},
						"diarization": map[string]interface{}{
							"use_separate_streams_when_available": true,
						},
					},
				},
				"realtime_endpoints": []map[string]interface{}{
					{
						"type": "webhook",
						"url":  webhookURL,
						"events": []string{
							"participant_events.join",
							"participant_events.leave",
							"participant_events.speech_on",
							"participant_events.speech_off",
							"transcript.data",
							"transcript.partial_data",
						},
					},
				},
			},
			"variant": map[string]string{
				"zoom":            "web_4_core",
				"google_meet":     "web_4_core",
				"microsoft_teams": "web_4_core",
				"webex":           "web_4_core",
			},
		}
	
		jsonBody, err := json.Marshal(payload)
		if err != nil {
			log.Printf("[PostRecallRequest] JSON marshal error: %v", err)
			return false, err
		}
	
		log.Printf("[PostRecallRequest] Request Body:\n%s", string(jsonBody))
	
		req, err := http.NewRequest("POST", recallURL, bytes.NewBuffer(jsonBody))
		if err != nil {
			log.Printf("[PostRecallRequest] request creation error: %v", err)
			return false, err
		}
	
		req.Header.Set("Authorization", recallToken)
		req.Header.Set("Content-Type", "application/json")
	
		client := &http.Client{
			Timeout: 30 * time.Second,
		}
	
		res, err := client.Do(req)
		if err != nil {
			log.Printf("[PostRecallRequest] request execution error: %v", err)
			return false, err
		}
		defer res.Body.Close()
	
		body, _ := io.ReadAll(res.Body)
	
		log.Printf("[PostRecallRequest] Response Status: %s", res.Status)
		log.Printf("[PostRecallRequest] Response Body: %s", string(body))
	
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return false, fmt.Errorf("recall api error: %s", string(body))
		}
	
		log.Printf("[PostRecallRequest] SUCCESS bot created")
	
		return true, nil
	}
// Get to get participants info
func GetAllParticipants(botId string) ([]recalltypes.Participant, error) {
	// Get Bot Information
	url := "https://us-west-2.recall.ai/api/v1/bot/" + botId
	method := "GET"
	client := &http.Client{}
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		fmt.Println(err)
		return []recalltypes.Participant{}, err
	}
	req.Header.Add("Authorization", os.Getenv("RECALL_API_TOKEN"))
	req.Header.Add("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		fmt.Println(err)
		return []recalltypes.Participant{}, err
	}
	defer res.Body.Close()
	// Parse Bot Information and Get Participants details
	var meetingResponse recalltypes.MeetingResponse
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return []recalltypes.Participant{}, err
	}
	err = json.Unmarshal(body, &meetingResponse)
	if err != nil {
		fmt.Println(err)
		return []recalltypes.Participant{}, err
	}
	if len(meetingResponse.Recordings) > 0 {
		// Get Participant Info
		url := meetingResponse.Recordings[0].MediaShortcuts.ParticipantEvents.Data.ParticipantsDownloadURL
		method := "GET"
		client := &http.Client{}
		req, err := http.NewRequest(method, url, nil)
		if err != nil {
			fmt.Println(err)
			return []recalltypes.Participant{}, err
		}
		req.Header.Add("Authorization", os.Getenv("RECALL_API_TOKEN"))
		req.Header.Add("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			fmt.Println(err)
			return []recalltypes.Participant{}, err
		}
		defer res.Body.Close()
		// Parse Bot Information and Get Participants details
		var participants []recalltypes.Participant
		body, err := io.ReadAll(res.Body)
		if err != nil {
			return []recalltypes.Participant{}, err
		}
		err = json.Unmarshal(body, &participants)
		if err != nil {
			fmt.Println(err)
			return []recalltypes.Participant{}, err
		}
		return participants, nil

	}
	return []recalltypes.Participant{}, nil
}

// Method to post new request to Infra
func PostAvatarRequest(inboxID string, lkRoomID string, meetingUrl string, from string) (bool, error) {
	avatarURL := "https://api.trugen.ai/v1/public/conversation/byemail"
	log.Printf("[PostAvatarRequest] Starting — inboxID=%q lkRoomID=%q meetingUrl=%q from=%q", inboxID, lkRoomID, meetingUrl, from)

	

	bodyStr := fmt.Sprintf(`{
    "email": "%s",
    "roomId": "%s",
    "meetingURL": "%s",
    "userName": "%s",
    "userId": "%s",
    "context": {
        "text": ""
    },
    "metadata": {
        "active": "true"
    }
}`, inboxID, lkRoomID, meetingUrl, from, from)

	log.Printf("[PostAvatarRequest] Sending POST to %s", avatarURL)
	log.Printf("[PostAvatarRequest] Request body:\n%s", bodyStr)
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("POST", avatarURL, strings.NewReader(bodyStr))

	if err != nil {
		log.Printf("[PostAvatarRequest] ERROR creating request: %v", err)

		return false, err
	}
	req.Header.Add("Content-Type", "application/json")

	res, err := client.Do(req)
	if err != nil {
		log.Printf("[PostAvatarRequest] ERROR executing request: %v", err)

		return false, err
	}
	defer res.Body.Close()

	respBody, err := io.ReadAll(res.Body)
	if err != nil {
		log.Printf("[PostAvatarRequest] ERROR reading response body: %v", err)
		return false, err
	}

	log.Printf("[PostAvatarRequest] Response status: %d %s", res.StatusCode, res.Status)
	log.Printf("[PostAvatarRequest] Response body: %s", string(respBody))

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		log.Printf("[PostAvatarRequest] FAILED — non-2xx status code %d", res.StatusCode)
		return false, fmt.Errorf("avatar request returned status %d: %s", res.StatusCode, string(respBody))
	}

	log.Printf("[PostAvatarRequest] SUCCESS")
	return true, nil
}


var Requests = make(map[string]*websocket.Conn)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Println(err)
		return
	}
	log.Printf("[WebSocket] New connection established — RemoteAddr=%s", r.RemoteAddr)
	defer conn.Close()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			fmt.Println("Connection closed")
			log.Printf("[WebSocket] Connection closed — RemoteAddr=%s", r.RemoteAddr)
			for k, v := range Requests {
				if v == conn {
					log.Printf("[WebSocket] Removing lkRoomID=%s from Requests map", k)
					delete(Requests, k)
				}
			}
			return
		}

		log.Printf("[WebSocket] Raw message received — length=%d bytes data=%s", len(data), string(data))
		var avatarEvent recalltypes.AvatarEvent
		err = json.Unmarshal(data, &avatarEvent)
		if err != nil {
			log.Printf("[WebSocket] Failed to unmarshal message — error=%v raw=%s", err, string(data))
			fmt.Println(err.Error())
		}
		log.Printf("[WebSocket] Parsed event — type=%q data=%q", avatarEvent.Type, avatarEvent.Data)
		// Add Request to Requests Map
		if avatarEvent.Type == "set_lk_room_id" {
			Requests[avatarEvent.Data] = conn
			log.Printf("[WebSocket] Registered lkRoomID=%s in Requests map — total active connections=%d", avatarEvent.Data, len(Requests))
			// Post pending requests
			for _, event := range PendingMessagesMap[avatarEvent.Data] {
				log.Printf("[WebSocket] Flushing pending event to lkRoomID=%s", avatarEvent.Data)
				conn.WriteJSON(event)
			}
			// Clear all PendingMessagesMap with Room Id after posting
			delete(PendingMessagesMap, avatarEvent.Data)
		}
	}
}

// Pending Messages to post
var PendingMessagesMap = make(map[string][]recalltypes.Event)

// Method to handle Recall.AI events
func handleRecallEvents(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room_id")
	if roomID == "" {
		roomID = r.PathValue("roomID") // Fallback for backward compatibility
	}
	log.Printf("[RecallWebhook] Event received — roomID=%s", roomID)
	defer r.Body.Close()
	var body recalltypes.Event
	_ = json.NewDecoder(r.Body).Decode(&body)
	log.Printf("[RecallWebhook] Event parsed — roomID=%s eventType=%+v", roomID, body)
	log.Printf("[Transcript] roomID=%s event=%+v", roomID, body)
	_, err := json.Marshal(&body)
	if err != nil {
		fmt.Println(err.Error())
		return
	}
	if Requests[roomID] != nil {
		log.Printf("[RecallWebhook] Forwarding event to active WebSocket — roomID=%s", roomID)
		Requests[roomID].WriteJSON(body)
	} else {
		log.Printf("[RecallWebhook] No active WebSocket for roomID=%s — queuing in PendingMessagesMap (queue size=%d)", roomID, len(PendingMessagesMap[roomID]))
		PendingMessagesMap[roomID] = append(PendingMessagesMap[roomID], body)
	}
}

// AWS Webhook 

// types used 
type LLMEvent struct {
    EventType     string   `json:"event_type"`      
    UID           string   `json:"uid"`             
    Title         string   `json:"title"`
    StartTimeUTC  string   `json:"start_time_utc"`  
    EndTimeUTC    string   `json:"end_time_utc"`
	RRule         string   `json:"rrule"`
    MeetingProv   string   `json:"meeting_provider"`
    MeetingLink   string   `json:"meeting_link"`
    Organizer     string   `json:"organizer_email"`
    Attendees     []string `json:"attendees"`
    Notes         string   `json:"notes"`
    Cron          string   `json:"cron"`
}

// convertRRuleToCron converts a basic RRULE string into a 5-field cron expression.
func convertRRuleToCron(rrule string, startTime time.Time) string {
    hour := startTime.UTC().Hour()
    minute := startTime.UTC().Minute()

    parts := strings.Split(rrule, ";")
    params := make(map[string]string)
    for _, p := range parts {
        kv := strings.SplitN(p, "=", 2)
        if len(kv) == 2 {
            params[strings.ToUpper(kv[0])] = kv[1]
        }
    }

    freq := params["FREQ"]
    switch freq {
    case "DAILY":
        return fmt.Sprintf("%d %d * * *", minute, hour)

    case "WEEKLY":
        dayMap := map[string]string{
            "SU": "0", "MO": "1", "TU": "2", "WE": "3",
            "TH": "4", "FR": "5", "SA": "6",
        }
        byDay := params["BYDAY"]
        if byDay == "" {
            // Fall back to the weekday of the start time
            weekdayAbbr := strings.ToUpper(startTime.UTC().Weekday().String()[:2])
            byDay = weekdayAbbr
        }
        var cronDays []string
        for _, d := range strings.Split(byDay, ",") {
            if num, ok := dayMap[strings.TrimSpace(strings.ToUpper(d))]; ok {
                cronDays = append(cronDays, num)
            }
        }
        if len(cronDays) == 0 {
            return ""
        }
        return fmt.Sprintf("%d %d * * %s", minute, hour, strings.Join(cronDays, ","))

    case "MONTHLY":
        day := startTime.UTC().Day()
        if d, ok := params["BYMONTHDAY"]; ok {
            fmt.Sscanf(d, "%d", &day)
        }
        return fmt.Sprintf("%d %d %d * *", minute, hour, day)

    default:
        return ""
    }
}





// extractRRuleUntil parses the UNTIL value from an RRULE string if present.
// Returns the parsed time and true if found and valid.
func extractRRuleUntil(rrule string) (time.Time, bool) {
    for _, part := range strings.Split(rrule, ";") {
        kv := strings.SplitN(part, "=", 2)
        if len(kv) == 2 && strings.ToUpper(kv[0]) == "UNTIL" {
            v := strings.TrimSpace(kv[1])
            // Try both formats: 20260301T000000Z and 20260301
            for _, layout := range []string{"20060102T150405Z", "20060102"} {
                t, err := time.Parse(layout, v)
                if err == nil {
                    return t.UTC(), true
                }
            }
        }
    }
    return time.Time{}, false
}
// helper func for duplicate job arriving in last 5 minutes
func recentlyFired(createdAt string) bool {
    t, err := time.Parse(time.RFC3339, createdAt)
    if err != nil {
        return false
    }
    return time.Since(t) < 5*time.Minute
}

//Retry wrapper for LLM (GROQ)
func callGroqLLMWithRetry(content string) (string, error) {
    maxAttempts := 3
    backoff := []time.Duration{0, 10 * time.Second, 30 * time.Second}

    var result string
    var err error

    for attempt := 0; attempt < maxAttempts; attempt++ {
        if backoff[attempt] > 0 {
            log.Printf("[LLM] Retrying — attempt %d/%d — waiting %s", attempt+1, maxAttempts, backoff[attempt])
            time.Sleep(backoff[attempt])
        }
        log.Printf("[LLM] Attempt %d/%d — calling LLM", attempt+1, maxAttempts)

        result, err = callGroqLLM(content)
        if err == nil && result != "" {
            log.Printf("[LLM] Attempt %d/%d SUCCESS — response length=%d chars", attempt+1, maxAttempts, len(result))
            return result, nil
        }
        if err != nil {
            log.Printf("[LLM] Attempt %d/%d FAILED — error=%v", attempt+1, maxAttempts, err)
        } else {
            log.Printf("[LLM] Attempt %d/%d FAILED — empty response", attempt+1, maxAttempts)
        }
    }
    return "", fmt.Errorf("LLM failed after %d attempts: %v", maxAttempts, err)
}






func HandleAWSLLM(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Only POST allowed", http.StatusMethodNotAllowed)
        return
    }

    raw, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "failed to read body", http.StatusBadRequest)
        return
    }
	w.WriteHeader(http.StatusOK) //to acknowledge SES retry

    

    log.Printf("[HandleAWSLLM] Received webhook — body size=%d bytes, Content-Type=%s", len(raw), r.Header.Get("Content-Type"))

    recipientEmail := extractRecipientEmail(raw)
    if recipientEmail == "" {
        log.Printf("[HandleAWSLLM] WARNING: could not extract recipient email from headers")
    } else {
        log.Printf("[HandleAWSLLM] Recipient (agent inbox): %s", recipientEmail)
    }

    content, err := BuildLLMPayload(raw)
    if err != nil {
        log.Printf("BuildLLMPayload error: %v", err)
        http.Error(w, "failed to extract content", http.StatusBadRequest)
        return
    }
    if content == "" {
        log.Printf("BuildLLMPayload returned empty content")
        http.Error(w, "no usable content", http.StatusBadRequest)
        return
    }
    log.Printf("[HandleAWSLLM] LLM input ready (%d chars)", len(content))

    //  LLM call
    llmText, err := callGroqLLMWithRetry(content)
    if err != nil {
        log.Printf("LLM call failed: %v", err)
        http.Error(w, "LLM call failed", http.StatusInternalServerError)
        return
    }
    log.Printf("[HandleAWSLLM] LLM response received (%d chars)", len(llmText))

    m := extractFirstJSONObject(llmText)
    if m == "" {
        log.Printf("No JSON object found in LLM response")
        http.Error(w, "LLM returned no JSON", http.StatusBadRequest)
        return
    }
    m = normalizeLLMJSON(m)
    log.Printf("[HandleAWSLLM] Extracted JSON (%d chars)", len(m))

    var ev LLMEvent
    if err := json.Unmarshal([]byte(m), &ev); err != nil {
        log.Printf("Failed to unmarshal LLM JSON: %v", err)
        http.Error(w, "invalid JSON from LLM: "+err.Error(), http.StatusBadRequest)
        return
    }

    if corrected, ok := extractUTCFromICS(content); ok {
        if ev.StartTimeUTC != corrected {
            log.Printf("[HandleAWSLLM] TIMEZONE CORRECTION: LLM said %q, ICS parser says %q — using ICS value", ev.StartTimeUTC, corrected)
            ev.StartTimeUTC = corrected
        } else {
            log.Printf("[HandleAWSLLM] Timezone check passed: LLM time %q matches ICS parse %q", ev.StartTimeUTC, corrected)
        }
    }

    log.Printf("[HandleAWSLLM] Parsed event — type=%q uid=%q title=%q meetingLink=%q startTime=%q cron=%q organizer=%q",
        ev.EventType, ev.UID, ev.Title, ev.MeetingLink, ev.StartTimeUTC, ev.Cron, ev.Organizer)

    if ev.EventType == "cancel" {
        log.Printf("[HandleAWSLLM] CANCEL event received — meetingLink=%q uid=%q", ev.MeetingLink, ev.UID)
        if ev.MeetingLink == "" {
            log.Printf("[HandleAWSLLM] Cancel event has no meeting link — cannot find job to cancel")
            w.WriteHeader(http.StatusNoContent)
            return
        }
        existing, err := GetAllJobsFromDB([]string{})
        if err != nil {
            log.Printf("[HandleAWSLLM] Cancel: DB error: %v", err)
            http.Error(w, "db error", http.StatusInternalServerError)
            return
        }
        cancelled := 0
        for _, j := range existing {
            matchByUID := ev.UID != "" && j.UID == ev.UID
            matchByURL := ev.MeetingLink != "" && j.MeetingURL == ev.MeetingLink
            if (matchByUID || matchByURL) && (j.Status == "scheduled" || j.Status == "" || j.Status == "processing" || j.Status == "retrying" || recentlyFired(j.CreatedAt)) {
                if matchByUID {
                    log.Printf("[HandleAWSLLM] Cancel: matched job %s by UID=%q", j.ID, ev.UID)
                } else {
                    log.Printf("[HandleAWSLLM] Cancel: matched job %s by URL=%q", j.ID, ev.MeetingLink)
                }
                // Remove from gocron scheduler
                if jobUUID, err := uuid.Parse(j.ID); err == nil {
                    if err := Scheduler.RemoveJob(jobUUID); err != nil {
                        log.Printf("[HandleAWSLLM] Cancel: could not remove job %s from scheduler: %v", j.ID, err)
                    } else {
                        log.Printf("[HandleAWSLLM] Cancel: removed job %s from scheduler", j.ID)
                    }
                }
				cancelCronJobIfExists(j.ID)
                // Remove from in-memory list
                ScheduledJobs = RemoveScheduleJob(ScheduledJobs, j.ID)
                // Update status in DB
                if err := UpdateJobStatusInDB(j.ID, "cancelled"); err != nil {
                    log.Printf("[HandleAWSLLM] Cancel: failed to update DB for job %s: %v", j.ID, err)
                } else {
                    log.Printf("[HandleAWSLLM] Cancel: job %s marked cancelled in DB", j.ID)
                }
                cancelled++
            }
        }
        log.Printf("[HandleAWSLLM] Cancel complete — %d job(s) cancelled for meetingURL=%q", cancelled, ev.MeetingLink)
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusOK)
        _ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "cancelled", "jobs_cancelled": cancelled})
        return
    }

    if ev.EventType == "update" {
        log.Printf("[HandleAWSLLM] UPDATE event received — meetingLink=%q uid=%q newStartTime=%q", ev.MeetingLink, ev.UID, ev.StartTimeUTC)
        if ev.MeetingLink == "" {
            log.Printf("[HandleAWSLLM] Update event has no meeting link — skipping")
            w.WriteHeader(http.StatusNoContent)
            return
        }
        // Cancel existing job for this meeting, then fall through to re-schedule below
        existing, err := GetAllJobsFromDB([]string{})
        if err != nil {
            log.Printf("[HandleAWSLLM] Update: DB error: %v", err)
            http.Error(w, "db error", http.StatusInternalServerError)
            return
        }
        for _, j := range existing {
            matchByUID := ev.UID != "" && j.UID == ev.UID
            matchByURL := ev.MeetingLink != "" && j.MeetingURL == ev.MeetingLink
            if (matchByUID || matchByURL) && (j.Status == "scheduled" || j.Status == ""|| j.Status == "processing" || j.Status == "retrying") {
                if matchByUID {
                    log.Printf("[HandleAWSLLM] Update: matched old job %s by UID=%q", j.ID, ev.UID)
                } else {
                    log.Printf("[HandleAWSLLM] Update: matched old job %s by URL=%q", j.ID, j.MeetingURL)
                }
                if jobUUID, err := uuid.Parse(j.ID); err == nil {
                    Scheduler.RemoveJob(jobUUID)
					cancelCronJobIfExists(j.ID)
                }
                ScheduledJobs = RemoveScheduleJob(ScheduledJobs, j.ID)
                UpdateJobStatusInDB(j.ID, "superseded")
                log.Printf("[HandleAWSLLM] Update: cancelled old job %s (will reschedule at new time)", j.ID)
            }
        }
        log.Printf("[HandleAWSLLM] Update: old job removed, rescheduling at new start time %q", ev.StartTimeUTC)
    }

    if ev.EventType == "none" {
        log.Printf("[HandleAWSLLM] event_type=none — no action")
        w.WriteHeader(http.StatusNoContent)
        return
    }

    if ev.EventType != "create" && ev.EventType != "update" {
        log.Printf("[HandleAWSLLM] Unknown event_type=%q — skipping", ev.EventType)
        w.WriteHeader(http.StatusNoContent)
        return
    }
    if ev.MeetingLink == "" {
        log.Printf("[HandleAWSLLM] Skipping — no meeting link, cron, or start_time in LLM response")
        http.Error(w, "no meeting link, cron, or start_time provided", http.StatusBadRequest)
        return
    }

    // Dedup: prevent double-scheduling
	if ev.MeetingLink != "" && !strings.HasPrefix(ev.MeetingLink, "http") {
    ev.MeetingLink = "https://" + ev.MeetingLink}
	scheduleMu.Lock()
    existing, dbErr := GetAllJobsFromDB([]string{})
    if dbErr == nil {
        for _, j := range existing {
            if j.MeetingURL == ev.MeetingLink && (j.Status == "scheduled" || j.Status == "" ||j.Status == "processing" || j.Status == "retrying" || recentlyFired(j.CreatedAt)) {
                scheduleMu.Unlock()
                log.Printf("[HandleAWSLLM] DUPLICATE -- job with meetingURL=%q already exists (jobID=%q), skipping", ev.MeetingLink, j.ID)
                return
            }
        }
    }

    // Determine fire time for the one-time job.
    
    var startTime time.Time
    happeningNow := false

    if ev.StartTimeUTC == "" {
		time.Sleep(2 * time.Second)

        log.Printf("[HandleAWSLLM] No start_time_utc — treating as HAPPENING NOW, firing immediately")
        startTime = time.Now().UTC()
        happeningNow = true
    } else if t, err := time.Parse(time.RFC3339, ev.StartTimeUTC); err != nil {
        log.Printf("[HandleAWSLLM] Could not parse start_time %q (%v) — firing immediately", ev.StartTimeUTC, err)
        startTime = time.Now().UTC()
        happeningNow = true
    } else {
        startTime = t
    }

    now := time.Now().UTC()
    delay := startTime.Sub(now)
    if happeningNow || delay <= 0 {
        if !happeningNow {
            log.Printf("[HandleAWSLLM] Meeting start %s was %s ago — firing immediately (late join)", startTime.Format(time.RFC3339), (-delay).Round(time.Second))
        }
        startTime = time.Now().UTC()
    } else {
        log.Printf("[HandleAWSLLM] Meeting starts in %s (at %s UTC) — job will fire then", delay.Round(time.Second), startTime.Format(time.RFC3339))
    }

    agentEmail := recipientEmail
    if agentEmail == "" {
        log.Printf("[HandleAWSLLM] Falling back to organizer email as agent email: %s", ev.Organizer)
        agentEmail = ev.Organizer
    }

    jobName := ev.Title
    if strings.TrimSpace(jobName) == "" {
        if ev.MeetingLink != "" {
            jobName = ev.MeetingLink
        } else {
            jobName = "meeting-" + uuid.New().String()[:8]
        }
        log.Printf("[HandleAWSLLM] Empty title from LLM — using fallback name: %q", jobName)
    }


	cronExpr := ""
	if ev.RRule != "" {
		cronExpr = convertRRuleToCron(ev.RRule, startTime)
		if cronExpr != "" {
			log.Printf("[HandleAWSLLM] Recurring meeting — RRULE=%q → cron=%q", ev.RRule, cronExpr)
		} else {
			log.Printf("[HandleAWSLLM] Could not convert RRULE=%q to cron — scheduling as one-time", ev.RRule)
		}
	}

    job := ScheduledJob{
        ID:           uuid.New().String(),
        Name:         jobName,
        MeetingURL:   ev.MeetingLink,
        AgentEmailID: agentEmail,
        Status:       "scheduled",
        Cron:         cronExpr,                        // empty = one-time, set = recurring cron
        StartTime:    startTime.Format(time.RFC3339),  // exact fire time
        UID:          ev.UID,                          // calendar UID
    }
    if cronExpr != "" {
        // Recurring job: expiry controls when the daily cron stops.
        // Use UNTIL from RRULE if present, otherwise default to 1 year.
        job.Expiry = startTime.AddDate(1, 0, 0).Format(time.RFC3339)
        if until, ok := extractRRuleUntil(ev.RRule); ok {
            job.Expiry = until.Format(time.RFC3339)
            log.Printf("[HandleAWSLLM] Recurring job UNTIL=%s extracted from RRULE", job.Expiry)
        } else {
            log.Printf("[HandleAWSLLM] Recurring job — no UNTIL in RRULE, defaulting expiry to 1 year: %s", job.Expiry)
        }
    } else if ev.EndTimeUTC != "" {
        // One-time job: expiry = meeting end time
        job.Expiry = ev.EndTimeUTC
    } else {
        job.Expiry = startTime.Add(1 * time.Hour).Format(time.RFC3339)
    }

    log.Printf("[HandleAWSLLM] Scheduling job — id=%s name=%q meetingURL=%q agentEmail=%q fireAt=%s expiry=%q",
        job.ID, job.Name, job.MeetingURL, job.AgentEmailID, startTime.Format(time.RFC3339), job.Expiry)

    scheduledID, err := ScheduleJob(job)
    if err != nil {
		scheduleMu.Unlock()
        log.Printf("[HandleAWSLLM] ERROR scheduling job: %v", err)
        http.Error(w, "failed to schedule job", http.StatusInternalServerError)
        return
    }
    job.ID = scheduledID.String()
    log.Printf("[HandleAWSLLM] Job scheduled successfully id=%s", job.ID)

    ScheduledJobs = append(ScheduledJobs, job)
    if err := AddJobToDB(job); err != nil {
        log.Printf("[HandleAWSLLM] WARNING: job scheduled but failed to persist to DB: %v", err)
    } else {
        log.Printf("[HandleAWSLLM] Job persisted to DB id=%s", job.ID)
    }
	scheduleMu.Unlock()

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated) //this causes the superflous in logs
    _ = json.NewEncoder(w).Encode(map[string]string{"status": "scheduled", "job_id": job.ID})
}

var jsonObjRe = regexp.MustCompile(`(?s)\{.*\}`)

func extractFirstJSONObject(s string) string {
    s = strings.TrimSpace(s)
    s = strings.TrimPrefix(s, "```json")
    s = strings.TrimPrefix(s, "```")
    s = strings.TrimSuffix(s, "```")
    m := jsonObjRe.FindString(s)
    return strings.TrimSpace(m)
}

func normalizeLLMJSON(s string) string {
    s = strings.TrimSpace(s)
    if strings.HasPrefix(s, "\"") && strings.HasSuffix(s, "\"") {
        if unq, err := strconv.Unquote(s); err == nil {
            s = unq
        }
    }
    s = strings.TrimSpace(s)
    return s
}

type ScheduledJob struct {
	Name         string `json:"name"`
	ID           string `json:"id"`
	Cron         string `json:"cron"`
	AgentEmailID string `json:"agentEmailID"`
	MeetingURL   string `json:"meetingUrl"`
	Expiry       string `json:"expiry"`
	Status       string `json:"status"`
	StartTime    string `json:"start_time,omitempty"` // RFC3339 UTC — used for one-time job scheduling
	UID          string `json:"uid,omitempty"`         // calendar UID — used for cancel/update matching
	CreatedAt    string `json:"created_at,omitempty"`

}

// Method to get all scheduled job
func HandleGetAllScheduledJobs(w http.ResponseWriter, r *http.Request) {
	scheduledJobsFromDB, err := GetAllJobsFromDB([]string{})
	if err != nil {
		fmt.Println(err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	scheduledJobs, err := json.Marshal(scheduledJobsFromDB)
	if err != nil {
		fmt.Println(err.Error())
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(scheduledJobs)
}

// Method to get scheduled job by ID
func HandleGetScheduledJob(w http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("jobID")
	// Get job from DB
	scheduledJobsFromDB, err := GetAllJobsFromDB([]string{}) // TODO: Make this faster
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	for _, item := range scheduledJobsFromDB {
		if item.ID == jobID {
			scheduledJob, err := json.Marshal(item)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write(scheduledJob)
			return
		}
	}
	// Return 404
	w.WriteHeader(http.StatusNotFound)
}

// Method to delete a scheduled job by ID
func HandleDeleteScheduledJob(w http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("jobID")
	// Get job from DB
	scheduledJobsFromDB, err := GetAllJobsFromDB([]string{}) // TODO: Make this faster
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	for _, item := range scheduledJobsFromDB {
		if item.ID == jobID {
			if item.Status == "cancelled" {
            w.WriteHeader(http.StatusNotFound)
            return}
			// Delete CRON Job
			uuidId, err := uuid.Parse(item.ID)
			// Update status in database
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			UpdateJobStatusInDB(item.ID, "cancelled")
			if err = Scheduler.RemoveJob(uuidId); err!=nil{
				log.Printf("[HandleDeleteScheduledJob] Job not in scheduler (may have already fired): %v", err)
			
			}
			cancelCronJobIfExists(item.ID)
			log.Printf("%s Job removed from the scheduler\n", item.ID)
			// Delete first occurance from array
			ScheduledJobs = RemoveScheduleJob(ScheduledJobs, item.ID)
			scheduledJob, err := json.Marshal(item)
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write(scheduledJob)
			return
		}
	}
	// Return 404
	w.WriteHeader(http.StatusNotFound)
}

// Method to add new Scheduled Job
func HandleAddScheduledJob(w http.ResponseWriter, r *http.Request) {
	// Parse the request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
	}
	var newJob ScheduledJob
	err = json.Unmarshal(body, &newJob)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	fmt.Println("Starting new Job from Rest API Trigger")
	// Job Schedule Logic
	if newJob.Expiry == "" || len(newJob.Expiry) <= 3 {
		// If Expiry is not found; then set the default as 30 days
		now := time.Now().UTC().AddDate(0, 0, 30)
		layout := "2006-01-02T15:04:05Z07:00"
		newJob.Expiry = now.Format(layout)
	}
		scheduleMu.Lock()	
		existing, dbErr := GetAllJobsFromDB([]string{})
		if dbErr == nil {
			for _, j := range existing {
				if j.MeetingURL == newJob.MeetingURL && (j.Status == "scheduled" || j.Status == "" || j.Status == "processing" || j.Status == "retrying"){
					scheduleMu.Unlock() 
					log.Printf("[HandleAddScheduledJob] Duplicate meetingURL=%q", newJob.MeetingURL)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusOK)
					_ = json.NewEncoder(w).Encode(map[string]string{"status": "already_scheduled", "job_id": j.ID})
					return
				}
			}	
		}
		newJob.Status = "scheduled"
	// Schedule a new job
	id, err := ScheduleJob(newJob)
	if err != nil {
		scheduleMu.Unlock() 
		log.Printf("[HandleAddScheduledJob] Failed to schedule: %v", err)
		http.Error(w, "failed to schedule job", http.StatusInternalServerError)
		return
	}
	// Set Job ID and return
	newJob.ID = id.String()
	ScheduledJobs = append(ScheduledJobs, newJob)
	// Add new item to database
	err = AddJobToDB(newJob)
	if err != nil {
		fmt.Println(err)
	}
	scheduleMu.Unlock()
	job, err := json.Marshal(newJob)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(job)
}

func HandleUpdateScheduledJob(w http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("jobID")

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	var patch struct {
		MeetingURL   string `json:"meetingUrl"`
		StartTime    string `json:"start_time"`
		Expiry       string `json:"expiry"`
		AgentEmailID string `json:"agentEmailID"`
		Name         string `json:"name"`
		Cron         string `json:"cron"`
	}
	if err := json.Unmarshal(body, &patch); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	// Find job in DB
	existing, err := GetAllJobsFromDB([]string{})
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}

	var found *ScheduledJob
	for _, j := range existing {
		if j.ID == jobID {
			copy := j
			found = &copy
			break
		}
	}
	if found == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	// Remove old job from scheduler
	if oldUUID, err := uuid.Parse(found.ID); err == nil {
		if err := Scheduler.RemoveJob(oldUUID);err != nil {
			log.Printf("[HandleUpdateScheduledJob] Job not in scheduler (may have already fired): %v", err)
		}
		
	}
	cancelCronJobIfExists(found.ID)
	ScheduledJobs = RemoveScheduleJob(ScheduledJobs, found.ID)
	UpdateJobStatusInDB(found.ID, "superseded")

	// Apply only provided fields
	if patch.MeetingURL != ""   { found.MeetingURL = patch.MeetingURL }
	if patch.StartTime != ""    { found.StartTime = patch.StartTime }
	if patch.Expiry != ""       { found.Expiry = patch.Expiry }
	if patch.AgentEmailID != "" { found.AgentEmailID = patch.AgentEmailID }
	if patch.Name != ""         { found.Name = patch.Name }
	if patch.Cron != ""         { found.Cron = patch.Cron }
	found.Status = "scheduled"
	found.ID = uuid.New().String() // new ID for new job

	// Reschedule
	newID, err := ScheduleJob(*found)
	if err != nil {
		log.Printf("[HandleUpdateScheduledJob] Failed to reschedule: %v", err)
		http.Error(w, "failed to reschedule job", http.StatusInternalServerError)
		return
	}
	found.ID = newID.String()
	ScheduledJobs = append(ScheduledJobs, *found)

	if err := AddJobToDB(*found); err != nil {
		log.Printf("[HandleUpdateScheduledJob] Failed to persist updated job: %v", err)
	}

	log.Printf("[HandleUpdateScheduledJob] Job updated — oldID=%s newID=%s", jobID, found.ID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(found)
}



// Method to remove job entry from schedule jobs list
func RemoveScheduleJob(scheduledJobs []ScheduledJob, jobID string) []ScheduledJob {
	for i, item := range scheduledJobs {
		if item.ID == jobID {
			// Delete first occurance from array
			scheduledJobs = append(scheduledJobs[:i], scheduledJobs[i+1:]...)
		}
	}
	return scheduledJobs
}

func joinMeeting(nj ScheduledJob, label string , failed *bool) {
	log.Printf("[ScheduleJob:%s] Job fired — Name=%q MeetingURL=%q AgentEmailID=%q", label, nj.Name, nj.MeetingURL, nj.AgentEmailID)
	lkRoomID := nj.ID
	if lkRoomID == "" {
		lkRoomID = uuid.New().String()
	}
	log.Printf("[ScheduleJob:%s] Using lkRoomID=%s", label, lkRoomID)
	dn := "Lisa"
	// Temporary state Processing
	UpdateJobStatusInDB(nj.ID, "processing")
	//Select camera URL: call external API for external domains, otherwise use default stream env var. 
	var cameraURL string
	var err error
	//For External Agent joins
	if isExternalAgent(nj.AgentEmailID) {
		log.Printf("[%s] External agent detected — calling external agent API", label)
		var agentName string
		var extRoomID string
		cameraURL, agentName , extRoomID, err = callExternalAgentAPI(nj.AgentEmailID, nj.MeetingURL, nj.StartTime, lkRoomID)

		if err != nil {
			log.Printf("[%s] External agent API failed — %v", label, err)
			UpdateJobStatusInDB(nj.ID, "failed")
			*failed = true
			return
		}
		if extRoomID != "" {                                                          
            log.Printf("[%s] Using external roomID=%s (replacing lkRoomID=%s)", label, extRoomID, lkRoomID)
            lkRoomID = extRoomID                                                      
        } else {                                                                        
            log.Printf("[%s] WARNING: external API returned no roomId — using generated lkRoomID=%s", label, lkRoomID)
        }  

		dn = agentName
		log.Printf("[%s] Got videoUrl — %s", label, cameraURL , lkRoomID)
	} else {
		// Existing flow 
		log.Printf("[%s] Default agent — using AVATAR_VIDEO_STREAM", label)
		cameraURL = fmt.Sprintf("%s/%s?agent=%s", os.Getenv("AVATAR_VIDEO_STREAM"), lkRoomID, url.QueryEscape(dn))
	}
	cameraURL = strings.TrimSpace(cameraURL)   
	log.Printf("[%s] Job status set to processing — lkRoomID=%s", label, lkRoomID)
	
	//Recall Retry attempt
	recallBackoff := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	maxRecallAttempts := 3
	var isSuccessful bool
	

	for attempt := 0; attempt < maxRecallAttempts; attempt++ {
		if recallBackoff[attempt] > 0 {
			log.Printf("[%s][Recall] Retrying — attempt %d/%d — waiting %s", label, attempt+1, maxRecallAttempts, recallBackoff[attempt])
			UpdateJobStatusInDB(nj.ID, "retrying")
			time.Sleep(recallBackoff[attempt])
		}
		log.Printf("[%s][Recall] Attempt %d/%d — sending bot to meeting", label, attempt+1, maxRecallAttempts)
		isSuccessful, err = PostRecallRequest(nj.MeetingURL, dn, cameraURL ,lkRoomID )
		if isSuccessful {
			log.Printf("[%s][Recall] Attempt %d/%d SUCCESS — bot created", label, attempt+1, maxRecallAttempts)
			break
		}
		log.Printf("[%s][Recall] Attempt %d/%d FAILED — error=%v", label, attempt+1, maxRecallAttempts, err)
	}

	if !isSuccessful {
		log.Printf("[%s][Recall] All %d attempts failed — marking job failed", label, maxRecallAttempts)
		UpdateJobStatusInDB(nj.ID, "failed")
		*failed = true
		return
	}



	//Avatar Retry attempt
	if !isExternalAgent(nj.AgentEmailID) {
		avatarBackoff := []time.Duration{0, 5 * time.Second, 15 * time.Second}
		maxAvatarAttempts := 3
		avatarSuccess := false
		var avatarErr error

		for attempt := 0; attempt < maxAvatarAttempts; attempt++ {
			if avatarBackoff[attempt] > 0 {
				log.Printf("[%s][Avatar] Retrying — attempt %d/%d — waiting %s", label, attempt+1, maxAvatarAttempts, avatarBackoff[attempt])
				UpdateJobStatusInDB(nj.ID, "retrying")
				time.Sleep(avatarBackoff[attempt])
			}
			log.Printf("[%s][Avatar] Attempt %d/%d — posting avatar request", label, attempt+1, maxAvatarAttempts)
			_, avatarErr = PostAvatarRequest(nj.AgentEmailID, lkRoomID, nj.MeetingURL, nj.Name)
			if avatarErr == nil {
				log.Printf("[%s][Avatar] Attempt %d/%d SUCCESS", label, attempt+1, maxAvatarAttempts)
				avatarSuccess = true
				break
			}
			log.Printf("[%s][Avatar] Attempt %d/%d FAILED — error=%v", label, attempt+1, maxAvatarAttempts, avatarErr)
		}

		if !avatarSuccess {
			log.Printf("[%s][Avatar] All %d attempts failed — marking job failed", label, maxAvatarAttempts)
			UpdateJobStatusInDB(nj.ID, "failed")
			*failed = true
			return
		}
	}
}

	
// scheduleCronJob registers a pure cron job (used for the 2nd+ occurrences of a recurring meeting).
func scheduleCronJob(nj ScheduledJob) error {
	cronJobFailed := false
	cronJob, err := Scheduler.NewJob(
		gocron.CronJob(nj.Cron, false),
		gocron.NewTask(func(job ScheduledJob) error {
			joinMeeting(job, "Cron" , &cronJobFailed)
			return nil
		}, nj),
		gocron.WithName(nj.Name+"-recurring"),
		gocron.WithEventListeners(
			gocron.AfterJobRuns(func(jobID uuid.UUID, jobName string) {
				layout := "2006-01-02T15:04:05Z07:00"
				exp, err := time.Parse(layout, nj.Expiry)
				if err != nil {
					log.Printf("[ScheduleJob:Cron] Could not parse expiry %q: %v", nj.Expiry, err)
					return
				}
				if time.Now().UTC().After(exp) {
					log.Printf("[ScheduleJob:Cron] Job expired — removing CronjobID=%s", jobID)
					Scheduler.RemoveJob(jobID)
					ScheduledJobs = RemoveScheduleJob(ScheduledJobs, jobID.String())
					cronRegistryMu.Lock()
					delete(CronJobRegistry , nj.ID)
					cronRegistryMu.Unlock()					
					UpdateJobStatusInDB(nj.ID, "expired")
				}
			}),
		),
	)
	if err != nil{
		return err
	} 
	// storing cron Job id
	cronRegistryMu.Lock()
	CronJobRegistry[nj.ID] = cronJob.ID()
	cronRegistryMu.Unlock()
	log.Printf("[ScheduleJob:Cron] Registered — cronJobID=%s parentJobID=%s cron=%q", cronJob.ID(), nj.ID, nj.Cron)
	

	return nil
}


// checks the in-memory registry and removes the cron job from gocron 
func cancelCronJobIfExists(parentJobID string) {
    cronRegistryMu.Lock()
    defer cronRegistryMu.Unlock()
    cronUUID, exists := CronJobRegistry[parentJobID]
    if !exists {
        log.Printf("[CancelCron] No cron job registered for parentJobID=%s", parentJobID)
        return
    }
    if err := Scheduler.RemoveJob(cronUUID); err != nil {
        log.Printf("[CancelCron] Cron job %s not in scheduler (may not have fired yet): %v", cronUUID, err)
    } else {
        log.Printf("[CancelCron] Cron job %s removed for parentJobID=%s", cronUUID, parentJobID)
    }
    delete(CronJobRegistry, parentJobID)
}

// Method to schedule a new job
func ScheduleJob(newJob ScheduledJob) (uuid.UUID, error) {
	// gocron empty string name set
	if strings.TrimSpace(newJob.Name) == "" {
		newJob.Name = "meeting-" + newJob.ID[:8]
		log.Printf("[ScheduleJob] Name was empty, using fallback: %q", newJob.Name)
	}

	isRecurring := len(strings.TrimSpace(newJob.Cron)) > 3

	// Determine the first-fire time (applies to both one-time and recurring).
	var oneTimeStart gocron.OneTimeJobStartAtOption
	if newJob.StartTime != "" {
		t, err := time.Parse(time.RFC3339, newJob.StartTime)
		if err == nil && t.After(time.Now().UTC().Add(10*time.Second)) {
			log.Printf("[ScheduleJob] First fire at %s UTC (in %s)", t.Format(time.RFC3339), t.Sub(time.Now().UTC()).Round(time.Second))
			oneTimeStart = gocron.OneTimeJobStartDateTime(t)
		} else {
			log.Printf("[ScheduleJob] Start time %q is in the past or unparseable — firing immediately", newJob.StartTime)
			oneTimeStart = gocron.OneTimeJobStartImmediately()
		}
	} else {
		log.Printf("[ScheduleJob] No start time — firing immediately")
		oneTimeStart = gocron.OneTimeJobStartImmediately()
	}
		jobFailed := false
		var gocronJobID uuid.UUID //for Job Id from gocron in db
		// Create a new One-Time Job
		j, err := Scheduler.NewJob(
		gocron.OneTimeJob(oneTimeStart),
		gocron.NewTask(func(nj ScheduledJob) error {
			nj.ID = gocronJobID.String()
			
			joinMeeting(nj, "OneTime", &jobFailed) // Fire the bot for the first (or only) occurrence

			// If this is a recurring meeting, now register the cron for future days.
			if isRecurring {
				log.Printf("[ScheduleJob:OneTime] Registering daily cron=%q for future occurrences", nj.Cron)
				if err := scheduleCronJob(nj); err != nil {
					log.Printf("[ScheduleJob:OneTime] ERROR registering cron job: %v", err)
				} else {
					log.Printf("[ScheduleJob:OneTime] Cron job registered successfully")
				}
			}
			return nil
		}, newJob),
		gocron.WithName(newJob.Name),
		gocron.WithEventListeners(
			gocron.AfterJobRuns(func(jobID uuid.UUID, jobName string) {
				if !isRecurring {
					// One-time job: clean up after it fires
					ScheduledJobs = RemoveScheduleJob(ScheduledJobs, jobID.String())
					if jobFailed{
						log.Printf("[AfterJobRuns] Job %s already failed ", jobID)
					} else {
						UpdateJobStatusInDB(jobID.String(), "completed")
						log.Printf("[AfterJobRuns] Job %s marked completed", jobID)
					}
						
					
				}
			}),
		),
	)
	if err != nil {
		return uuid.New(), err
	}
	gocronJobID = j.ID() 
	log.Printf("[ScheduleJob] Registered one-time bootstrap job id=%s recurring=%v", j.ID(), isRecurring)
	return j.ID(), nil
}
// Identifier for different platform agents flow 
func isExternalAgent(email string) bool {
	domain := os.Getenv("EXTERNAL_AGENT_DOMAIN")
	if domain == "" {
		return false
	}
	normalised := strings.ReplaceAll(domain, ".", "")          // "clawdfaceai"
    return strings.Contains(strings.ToLower(email), normalised)
}

// External Func. to  send meeting details to the external agent system and receives a video stream URL to pass to Recall as the camera feed.
func callExternalAgentAPI(agentEmail string, meetingUrl string, startTime string, roomId string) (string,string, string, error) {
	apiURL := os.Getenv("EXTERNAL_AGENT_API_URL")
	if apiURL == "" {
		return "" ,"", "", fmt.Errorf("EXTERNAL_AGENT_API_URL is not set") 
	}

	payload := map[string]string{
		"email":      agentEmail,
		"meetingUrl": meetingUrl,
		"startTime":  startTime,
		"roomId":     roomId,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "" ,"", "", fmt.Errorf("failed to marshal payload: %v", err)
	}

	req, err := http.NewRequest("POST", apiURL+"/api/start-agent", bytes.NewBuffer(body))  //
	if err != nil {
		return "" ,"","", fmt.Errorf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return "","","", fmt.Errorf("request failed: %v", err)
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(res.Body)
	log.Printf("[callExternalAgentAPI] status=%d body=%s", res.StatusCode, string(respBody))

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "","","", fmt.Errorf("external agent API error %d: %s", res.StatusCode, string(respBody))
	}

	var result struct {
		VideoUrl string `json:"videoUrl"`
		AgentName string `json:"agentName"`
		RoomId    string `json:"roomId"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "","","", fmt.Errorf("failed to parse response: %v", err)
	}
	if result.VideoUrl == "" {
		return "" ,"","", fmt.Errorf("external agent API returned empty videoUrl")
	}
	//Name extraction
	agentName := result.AgentName
    if agentName == "" {
        agentName = agentEmail
    }


	return result.VideoUrl, agentName , result.RoomId , nil
}

// Route for external systems to dispatch meeting bot via this Go server.

func HandleExternalJoin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email      string `json:"email"`      // agent email ID — required
		MeetingURL string `json:"meetingUrl"` // meeting link — required
		StartTime  string `json:"startTime"`  // RFC3339 or empty = fire immediately
		Name       string `json:"name"`       // optional job display name
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid JSON"})
		return
	}

	if req.Email == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "email is required"})
		return
	}
	if req.MeetingURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "meetingUrl is required"})
		return
	}
	if req.Name == "" {
		req.Name = "External Join — " + req.MeetingURL
	}

	// Dedup check
	scheduleMu.Lock()
	existing, dbErr := GetAllJobsFromDB([]string{})
	if dbErr == nil {
		for _, j := range existing {
			if j.MeetingURL == req.MeetingURL &&
				(j.Status == "scheduled" ||
					j.Status == "processing" ||
					j.Status == "retrying") {
				scheduleMu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]string{
					"status": "already_scheduled",
					"job_id": j.ID,
				})
				return
			}
		}
	}

	newJob := ScheduledJob{
		Name:         req.Name,
		MeetingURL:   req.MeetingURL,
		AgentEmailID: req.Email,
		StartTime:    req.StartTime,
		Expiry:       time.Now().UTC().AddDate(0, 0, 1).Format(time.RFC3339),
		Status:       "scheduled",
	}

	jobID, err := ScheduleJob(newJob)
	if err != nil {
		scheduleMu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	newJob.ID = jobID.String()
	scheduleMu.Unlock()

	log.Printf("[ExternalJoin] Job created — id=%s meetingUrl=%s email=%s",
		newJob.ID, newJob.MeetingURL, req.Email)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "scheduled",
		"job_id":     newJob.ID,
		"meetingUrl": newJob.MeetingURL,
		"email":      req.Email,
	})
}

var ScheduledJobs []ScheduledJob
var Scheduler gocron.Scheduler
var scheduleMu sync.Mutex
var CronJobRegistry = make(map[string]uuid.UUID) //for storing recurring jobs gocron id
var cronRegistryMu sync.Mutex
func main() {
	godotenv.Load() // Loading .env file values
	log.Println("[Startup] DATABASE_URL =", os.Getenv("DATABASE_URL"))
	// Instantiate Scheduled Jobs
	ScheduledJobs = []ScheduledJob{}
	var err error
	//db, err = sql.Open("sqlite3", "./scheduled_tasks.db")
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL environment variable is not set")
	}
	db, err = sql.Open("postgres", dsn)
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err = db.Ping(); err != nil {
		log.Fatalf("Cannot connect to Postgres: %v", err)
	}
	log.Println("[Startup] Connected to Postgres successfully")
		if err != nil { log.Fatal(err) }
		if err := db.Ping(); err != nil { log.Fatal(err) }
		if err := ensureSchema(db); err != nil { log.Fatalf("schema init failed: %v", err) }



	// REST API and WS Routes
	router := http.NewServeMux()
	// Avatar Event Manager Route
	router.HandleFunc("/webhook", HandleAWSLLM) // AWS Lambda forwarder
	router.HandleFunc("/ws", handleWebSocket)

	// Health Check
	router.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Healthy"))
	})
	router.HandleFunc("POST /api/v1/webhook", handleRecallEvents)
	router.HandleFunc("POST /api/v1/webhook/{roomID}", handleRecallEvents)
	//router.HandleFunc("POST /api/v1/agentmailwebhook", handleAgentMail)
	// Scheduled Job Route
	router.HandleFunc("GET /api/v1/jobs", HandleGetAllScheduledJobs)
	router.HandleFunc("GET /api/v1/jobs/{jobID}", HandleGetScheduledJob)
	router.HandleFunc("DELETE /api/v1/jobs/{jobID}", HandleDeleteScheduledJob)
	router.HandleFunc("POST /api/v1/jobs", HandleAddScheduledJob)
	router.HandleFunc("PATCH /api/v1/jobs/{jobID}", HandleUpdateScheduledJob)
	router.HandleFunc("POST /api/v1/join", HandleExternalJoin)
	// Instantiate new scheduler
	s, err := gocron.NewScheduler()
	if err != nil {
		log.Fatal(err)
	}
	Scheduler = s
	// Start the scheduler
	Scheduler.Start()
	
	//  re-register jobs that were scheduled before
	pendingJobs, err := GetAllJobsFromDB([]string{})
	if err != nil {
		log.Printf("[ error : could not read jobs from DB: %v", err)
	} else {
		rehydrated := 0
		skipped := 0
		for _, j := range pendingJobs {
			if j.Status == "processing" || j.Status == "retrying" {
				log.Printf("[Rehydration] Job %s was %s when server died — resetting to scheduled", j.ID, j.Status)
				UpdateJobStatusInDB(j.ID, "scheduled")
				j.Status = "scheduled"
			}

			if j.Status != "scheduled" {
				skipped++
				continue
			}

			//  if  jobs start time is past , fire immediately already passed
			if j.StartTime != "" {
				t, err := time.Parse(time.RFC3339, j.StartTime)
				if err == nil && t.Before(time.Now().UTC().Add(-2*time.Hour)) {
					// More than 2 hours late , mark expire
					log.Printf("[Rehydration] Job %s start time %s is >2h in the past — marking expired", j.ID, j.StartTime)
					UpdateJobStatusInDB(j.ID, "expired")
					skipped++
					continue
				}
			}

			if _, err := ScheduleJob(j); err != nil {
				log.Printf("[Rehydration] Failed to rehydrate job %s: %v", j.ID, err)
				skipped++
			} else {
				ScheduledJobs = append(ScheduledJobs, j)
				rehydrated++
				log.Printf("[Rehydration] Re-registered job %s name=%q fireAt=%s", j.ID, j.Name, j.StartTime)
			}
		}
		log.Printf("[Rehydration] Complete — rehydrated=%d skipped=%d total=%d", rehydrated, skipped, len(pendingJobs))
	}

	// Setup a channel to get the interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		_ = Scheduler.Shutdown()
		log.Println("Scheduler shutdown.")
		os.Exit(0)
	}()

	fmt.Println("Server running at 9999")
	if err := http.ListenAndServe(":9999", router); err != nil {
		log.Fatal(err)
	}
}
