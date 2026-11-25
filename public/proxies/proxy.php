<?php
/**
 * Neon Gmail — Standalone PHP IMAP/SMTP CORS Proxy
 *
 * Zero external dependencies (pure PHP 8.0+ sockets & OpenSSL; ext-imap & ext-mbstring NOT required).
 * Upload this single file to any PHP web host (Apache, Nginx, Sakura, Xserver, Lolipop, etc.)
 * and enter its URL in Neon Gmail's Login Dialog -> Proxy URL.
 *
 * Optional environment variables:
 *   NEON_PROXY_TOKEN       Require matching `X-Proxy-Token` HTTP header.
 *   NEON_ALLOW_CUSTOM_PORT Set to "1" to allow non-standard mail ports.
 *   NEON_ALLOW_LOCAL_TEST  Set to "1" ONLY for local automated testing (disables private-IP block).
 */

declare(strict_types=1);

@ini_set('display_errors', '0');

// Always emit CORS headers on every response path
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Proxy-Token');
header('Access-Control-Max-Age: 86400');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const NEON_MAX_BODY_BYTES = 15728640; // 15 MB
const NEON_ALLOWED_PORTS = [143, 993, 25, 465, 587, 2525, 1143, 1025];

function respond_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function assert_no_crlf(string $value, string $field): string
{
    if (preg_match('/[\r\n\0]/', $value)) {
        throw new InvalidArgumentException("{$field} must not contain CR, LF, or NUL bytes.");
    }
    return $value;
}

function is_private_ipv4_bytes(int $a, int $b, int $c, int $d): bool
{
    if ($a === 0 || $a === 10 || $a === 127 || $a >= 224) return true;
    if ($a === 100 && $b >= 64 && $b <= 127) return true; // CGNAT 100.64.0.0/10
    if ($a === 169 && $b === 254) return true;            // Link-local / cloud metadata
    if ($a === 172 && $b >= 16 && $b <= 31) return true;  // RFC 1918
    if ($a === 192 && $b === 0 && ($c === 0 || $c === 2)) return true;
    if ($a === 192 && $b === 88 && $c === 99) return true; // 6to4 relay
    if ($a === 192 && $b === 168) return true;             // RFC 1918
    if ($a === 198 && ($b === 18 || $b === 19)) return true;
    if ($a === 198 && $b === 51 && $c === 100) return true;
    if ($a === 203 && $b === 0 && $c === 113) return true;
    return $d < 0; // unreachable safety fallback
}

function is_blocked_ip(string $ip): bool
{
    $bin = @inet_pton($ip);
    if ($bin === false) {
        return true;
    }
    if (strlen($bin) === 4) {
        $b = unpack('C4', $bin);
        return is_private_ipv4_bytes($b[1], $b[2], $b[3], $b[4]);
    }
    if (strlen($bin) === 16) {
        $g = unpack('n8', $bin);
        $zeroFirst6 = $g[1] === 0 && $g[2] === 0 && $g[3] === 0 && $g[4] === 0 && $g[5] === 0 && $g[6] === 0;
        // ::/128, ::1/128, and deprecated ::/96 IPv4-compatible
        if ($zeroFirst6) return true;
        // ::ffff:0:0/96 IPv4-mapped IPv6 -> check embedded IPv4
        if ($g[1] === 0 && $g[2] === 0 && $g[3] === 0 && $g[4] === 0 && $g[5] === 0 && $g[6] === 0xffff) {
            return is_private_ipv4_bytes($g[7] >> 8, $g[7] & 0xff, $g[8] >> 8, $g[8] & 0xff);
        }
        // NAT64 64:ff9b::/96 & 64:ff9b:1::/48
        if ($g[1] === 0x0064 && $g[2] === 0xff9b && ($g[3] === 0 || $g[3] === 1)) return true;
        // Discard 100::/64
        if ($g[1] === 0x0100 && $g[2] === 0 && $g[3] === 0 && $g[4] === 0) return true;
        // Teredo 2001::/32, Doc 2001:db8::/32, Benchmark 2001:2::/48
        if ($g[1] === 0x2001 && ($g[2] === 0x0000 || $g[2] === 0x0db8 || ($g[2] === 0x0002 && $g[3] === 0))) return true;
        // 6to4 2002::/16
        if ($g[1] === 0x2002) return true;
        // Unique local fc00::/7
        if (($g[1] & 0xfe00) === 0xfc00) return true;
        // Link-local fe80::/10
        if (($g[1] & 0xffc0) === 0xfe80) return true;
        // Multicast ff00::/8
        if (($g[1] & 0xff00) === 0xff00) return true;
        return false;
    }
    return true;
}

/**
 * Validates mail host and returns pinned IP to prevent DNS-rebinding TOCTOU.
 * @return array{host: string, ip: string}
 */
function validate_host(mixed $rawHost, bool $allowLocalTest = false): array
{
    if (!is_string($rawHost)) {
        throw new InvalidArgumentException('Mail host must be a non-empty string.');
    }
    $host = strtolower(trim($rawHost));
    if ($host === '' || strlen($host) > 253 || preg_match('/[\r\n\t\s@\\\\\/?#%]/', $host)) {
        throw new InvalidArgumentException('Invalid mail server host.');
    }
    if ($allowLocalTest) {
        return ['host' => $host, 'ip' => trim($host, '[]')];
    }

    $blocked = ['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data'];
    if (in_array($host, $blocked, true) || str_ends_with($host, '.local') || str_ends_with($host, '.internal') || str_ends_with($host, '.localhost')) {
        throw new InvalidArgumentException('Connections to local or internal hosts are blocked.');
    }

    // Strict bracketed/bare IP literal handling
    if (str_contains($host, ':') || str_contains($host, '[') || str_contains($host, ']')) {
        $unwrapped = $host;
        if (str_starts_with($host, '[') || str_ends_with($host, ']')) {
            if (!(str_starts_with($host, '[') && str_ends_with($host, ']'))) {
                throw new InvalidArgumentException('Malformed bracketed IPv6 host.');
            }
            $unwrapped = substr($host, 1, -1);
        }
        if (filter_var($unwrapped, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
            throw new InvalidArgumentException('Invalid IPv6 or colon-containing mail host.');
        }
        if (is_blocked_ip($unwrapped)) {
            throw new InvalidArgumentException('Connections to private, loopback, or reserved IPv6 addresses are blocked.');
        }
        return ['host' => $unwrapped, 'ip' => $unwrapped];
    }

    if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
        if (is_blocked_ip($host)) {
            throw new InvalidArgumentException('Connections to private, loopback, or reserved IP addresses are blocked.');
        }
        return ['host' => $host, 'ip' => $host];
    }

    // Reject obfuscated integer/hex/octal/short-form IP formats
    if (preg_match('/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i', $host)) {
        throw new InvalidArgumentException('Obfuscated IP hostnames are blocked.');
    }

    $parts = explode('.', $host);
    $tld = end($parts) ?: '';
    if (!str_contains($host, '.') || !preg_match('/[a-z]/', $tld) || !preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/', $host)) {
        throw new InvalidArgumentException('Invalid mail server hostname format.');
    }

    // Resolve DNS and pin verified IP so stream_socket_client never re-resolves (prevents DNS rebinding TOCTOU)
    $ips = [];
    $v4 = @gethostbynamel($host);
    if (is_array($v4)) {
        $ips = array_merge($ips, $v4);
    }
    $aaaa = @dns_get_record($host, DNS_AAAA);
    if (is_array($aaaa)) {
        foreach ($aaaa as $rec) {
            if (!empty($rec['ipv6'])) {
                $ips[] = $rec['ipv6'];
            }
        }
    }
    if ($ips === []) {
        throw new RuntimeException("Could not resolve mail server hostname: {$host}");
    }
    foreach ($ips as $ip) {
        if (is_blocked_ip($ip)) {
            throw new InvalidArgumentException('Mail server hostname resolves to a private or reserved IP address.');
        }
    }

    return ['host' => $host, 'ip' => $ips[0]];
}

function format_connect_target(string $ip, int $port): string
{
    return str_contains($ip, ':') ? "[{$ip}]:{$port}" : "{$ip}:{$port}";
}

function validate_port(mixed $rawPort, bool $allowCustom = false): int
{
    $port = filter_var($rawPort, FILTER_VALIDATE_INT);
    if ($port === false || $port < 1 || $port > 65535) {
        throw new InvalidArgumentException('Invalid port number.');
    }
    if (!$allowCustom && !in_array($port, NEON_ALLOWED_PORTS, true)) {
        throw new InvalidArgumentException("Port {$port} is not allowed.");
    }
    return $port;
}

function validate_email(mixed $raw, string $field = 'email'): string
{
    if (!is_string($raw)) {
        throw new InvalidArgumentException("{$field} must be a string.");
    }
    $trimmed = assert_no_crlf(trim($raw), $field);
    $addr = preg_match('/<([^<>]+)>/', $trimmed, $m) ? $m[1] : $trimmed;
    if ($addr === '' || strlen($addr) > 254 || filter_var($addr, FILTER_VALIDATE_EMAIL) === false) {
        throw new InvalidArgumentException("Invalid email address in {$field}.");
    }
    return $addr;
}

function validate_uids(mixed $raw): array
{
    $arr = is_array($raw) ? $raw : [$raw];
    if ($arr === [] || count($arr) > 500) {
        throw new InvalidArgumentException('UID list must contain 1 to 500 positive integers.');
    }
    $out = [];
    foreach ($arr as $item) {
        $n = filter_var($item, FILTER_VALIDATE_INT);
        if ($n === false || $n <= 0 || $n > 4294967295) {
            throw new InvalidArgumentException('Invalid IMAP UID.');
        }
        $out[] = $n;
    }
    return $out;
}

function quote_imap(string $val): string
{
    assert_no_crlf($val, 'IMAP argument');
    return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $val) . '"';
}

function safe_substr_utf8(string $s, int $maxLen): string
{
    if (function_exists('mb_substr')) {
        return mb_substr($s, 0, $maxLen, 'UTF-8');
    }
    return substr($s, 0, $maxLen);
}

function decode_rfc2047(string $value): string
{
    if (!str_contains($value, '=?')) {
        return $value;
    }
    $collapsed = preg_replace('/\?=\s+=\?/', '?==?', $value) ?? $value;
    return preg_replace_callback(
        '/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/',
        static function (array $m): string {
            $charset = strtoupper(trim($m[1]));
            $enc = strtoupper($m[2]);
            $raw = $enc === 'B'
                ? (base64_decode($m[3], true) ?: '')
                : quoted_printable_decode(str_replace('_', ' ', $m[3]));
            if ($charset !== 'UTF-8' && $charset !== 'US-ASCII' && function_exists('mb_convert_encoding')) {
                $converted = @mb_convert_encoding($raw, 'UTF-8', $charset);
                if (is_string($converted)) {
                    return $converted;
                }
            }
            return $raw;
        },
        $collapsed
    ) ?? $value;
}

function encode_rfc2047(string $value): string
{
    assert_no_crlf($value, 'header');
    if (preg_match('/^[\x20-\x7e]*$/', $value)) {
        return $value;
    }
    // Split UTF-8 safely into <=45-byte chunks so each encoded-word stays <=75 chars
    $chars = preg_split('//u', $value, -1, PREG_SPLIT_NO_EMPTY) ?: [$value];
    $words = [];
    $buf = '';
    foreach ($chars as $ch) {
        if (strlen($buf) + strlen($ch) > 45 && $buf !== '') {
            $words[] = '=?UTF-8?B?' . base64_encode($buf) . '?=';
            $buf = '';
        }
        $buf .= $ch;
    }
    if ($buf !== '') {
        $words[] = '=?UTF-8?B?' . base64_encode($buf) . '?=';
    }
    return implode(' ', $words);
}

function format_display_name(string $name): string
{
    $trimmed = assert_no_crlf(trim($name), 'fromName');
    if ($trimmed === '') return '';
    if (!preg_match('/^[\x20-\x7e]*$/', $trimmed)) {
        return encode_rfc2047($trimmed);
    }
    if (preg_match('/[()<>@,;:\\\\".\[\]]/', $trimmed)) {
        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $trimmed) . '"';
    }
    return $trimmed;
}

function parse_headers(string $headerBlock): array
{
    $unfolded = preg_replace('/\r?\n[ \t]+/', ' ', $headerBlock) ?? $headerBlock;
    $headers = [];
    foreach (preg_split('/\r?\n/', $unfolded) ?: [] as $line) {
        $pos = strpos($line, ':');
        if ($pos === false || $pos === 0) continue;
        $k = strtolower(trim(substr($line, 0, $pos)));
        $v = trim(substr($line, $pos + 1));
        $headers[$k] = isset($headers[$k]) ? ($headers[$k] . ', ' . $v) : $v;
    }
    return $headers;
}

function decode_rfc2231_value(string $rawVal): string
{
    $charset = 'UTF-8';
    $encoded = $rawVal;
    if (preg_match("/^([^']*)'[^']*'(.*)$/", $rawVal, $m)) {
        if ($m[1] !== '') $charset = strtoupper($m[1]);
        $encoded = $m[2];
    }
    $bytes = rawurldecode($encoded);
    if ($charset !== 'UTF-8' && $charset !== 'US-ASCII' && function_exists('mb_convert_encoding')) {
        $conv = @mb_convert_encoding($bytes, 'UTF-8', $charset);
        if (is_string($conv)) return $conv;
    }
    return $bytes;
}

function extract_header_param(string $headerVal, string $name): ?string
{
    $q = preg_quote($name, '/');
    if (preg_match('/(?:^|;)\s*' . $q . '\*\s*=\s*(?:"([^"]*)"|([^;\s]+))/i', $headerVal, $em)) {
        return decode_rfc2231_value($em[1] !== '' ? $em[1] : ($em[2] ?? ''));
    }
    if (preg_match_all('/(?:^|;)\s*' . $q . '\*(\d+)(\*?)\s*=\s*(?:"([^"]*)"|([^;\s]+))/i', $headerVal, $cm, PREG_SET_ORDER)) {
        usort($cm, static fn($a, $b) => (int)$a[1] <=> (int)$b[1]);
        $joined = '';
        $isEnc = false;
        foreach ($cm as $row) {
            if ($row[2] === '*') $isEnc = true;
            $joined .= ($row[3] !== '' ? $row[3] : ($row[4] ?? ''));
        }
        return $isEnc ? decode_rfc2231_value($joined) : decode_rfc2047($joined);
    }
    if (preg_match('/(?:^|;)\s*' . $q . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^;\s]+))/i', $headerVal, $m)) {
        $v = $m[1] !== '' ? $m[1] : ($m[2] !== '' ? $m[2] : ($m[3] ?? ''));
        return decode_rfc2047($v);
    }
    return null;
}

function split_header_body(string $raw): array
{
    $pos = strpos($raw, "\r\n\r\n");
    if ($pos !== false) return [substr($raw, 0, $pos), substr($raw, $pos + 4)];
    $pos = strpos($raw, "\n\n");
    if ($pos !== false) return [substr($raw, 0, $pos), substr($raw, $pos + 2)];
    return [$raw, ''];
}

function decode_transfer(string $body, string $encoding, string $charset): array
{
    $enc = strtolower(trim($encoding));
    $bytes = match ($enc) {
        'base64' => base64_decode(preg_replace('/\s+/', '', $body) ?? '', true) ?: '',
        'quoted-printable' => quoted_printable_decode($body),
        default => $body,
    };
    $text = $bytes;
    $cs = strtoupper(trim($charset, " \t\"'"));
    if ($cs !== '' && $cs !== 'UTF-8' && $cs !== 'US-ASCII' && function_exists('mb_convert_encoding')) {
        $conv = @mb_convert_encoding($bytes, 'UTF-8', $cs);
        if (is_string($conv)) $text = $conv;
    }
    return [$text, $bytes];
}

function walk_mime(string $raw, array &$acc, int $depth = 0): void
{
    if ($depth > 8) return;
    [$headerText, $bodyText] = split_header_body($raw);
    $headers = parse_headers($headerText);
    $ctHeader = $headers['content-type'] ?? 'text/plain; charset=utf-8';
    $mimeType = strtolower(trim(explode(';', $ctHeader)[0] ?? 'text/plain'));
    $charset = extract_header_param($ctHeader, 'charset') ?? 'utf-8';
    $transfer = $headers['content-transfer-encoding'] ?? '7bit';
    $disp = $headers['content-disposition'] ?? '';

    if (str_starts_with($mimeType, 'multipart/')) {
        $boundary = extract_header_param($ctHeader, 'boundary');
        if ($boundary === null || $boundary === '') return;
        $re = '/(?:^|\r?\n)--' . preg_quote($boundary, '/') . '(--)?[ \t]*(?:\r?\n|$)/';
        if (preg_match_all($re, $bodyText, $matches, PREG_OFFSET_CAPTURE)) {
            $prevEnd = null;
            foreach ($matches[0] as $idx => $m) {
                if ($prevEnd !== null) {
                    $seg = substr($bodyText, $prevEnd, $m[1] - $prevEnd);
                    if (trim($seg) !== '') walk_mime($seg, $acc, $depth + 1);
                }
                if (!empty($matches[1][$idx][0])) break;
                $prevEnd = $m[1] + strlen($m[0]);
            }
        }
        return;
    }

    $filename = extract_header_param($disp, 'filename') ?? extract_header_param($ctHeader, 'name');
    $isAttachment = str_starts_with(strtolower($disp), 'attachment')
        || ($filename !== null && $mimeType !== 'text/plain' && $mimeType !== 'text/html');

    [$text, $bytes] = decode_transfer($bodyText, $transfer, $charset);

    if ($isAttachment) {
        $size = strlen($bytes);
        $acc['attachments'][] = [
            'filename' => $filename ?: 'attachment.bin',
            'contentType' => $mimeType,
            'size' => $size,
            'contentId' => isset($headers['content-id']) ? trim($headers['content-id'], '<>') : null,
            'dataBase64' => $size <= 5242880 ? base64_encode($bytes) : '',
        ];
        return;
    }

    if ($mimeType === 'text/html') $acc['html'][] = $text;
    elseif ($mimeType === 'text/plain') $acc['text'][] = $text;
}

function parse_mime_message(string $raw): array
{
    [$headerText] = split_header_body($raw);
    $headers = parse_headers($headerText);
    $acc = ['text' => [], 'html' => [], 'attachments' => []];
    walk_mime($raw, $acc, 0);

    $textBody = trim(implode("\n", $acc['text']));
    $htmlBody = trim(implode("\n", $acc['html']));
    $snippetSrc = $textBody !== ''
        ? $textBody
        : trim(preg_replace('/\s+/', ' ', strip_tags(preg_replace('/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/i', ' ', $htmlBody) ?? $htmlBody)) ?? '');

    return [
        'subject' => decode_rfc2047($headers['subject'] ?? '(No Subject)'),
        'from' => decode_rfc2047($headers['from'] ?? ''),
        'to' => decode_rfc2047($headers['to'] ?? ''),
        'cc' => decode_rfc2047($headers['cc'] ?? ''),
        'date' => $headers['date'] ?? gmdate('D, d M Y H:i:s') . ' +0000',
        'messageId' => $headers['message-id'] ?? '',
        'inReplyTo' => $headers['in-reply-to'] ?? '',
        'references' => $headers['references'] ?? '',
        'textBody' => $textBody,
        'htmlBody' => $htmlBody,
        'snippet' => safe_substr_utf8(preg_replace('/\s+/', ' ', $snippetSrc) ?? '', 180),
        'attachments' => $acc['attachments'],
    ];
}

class PhpImapClient
{
    /** @var resource|null */
    private $fp = null;
    private int $tag = 0;
    private bool $broken = false;
    public string $greeting = '';

    public function __construct(array $cfg, bool $allowCustomPorts, bool $allowLocalTest)
    {
        $resolved = validate_host($cfg['host'] ?? '', $allowLocalTest);
        $host = $resolved['host'];
        $ip = $resolved['ip'];
        $port = validate_port($cfg['port'] ?? 993, $allowCustomPorts);
        $tls = (string)($cfg['tls'] ?? ($port === 993 ? 'tls' : 'starttls'));
        $scheme = $tls === 'tls' ? 'tls://' : 'tcp://';

        $context = stream_context_create([
            'ssl' => [
                'verify_peer' => !$allowLocalTest,
                'verify_peer_name' => !$allowLocalTest,
                'allow_self_signed' => $allowLocalTest,
                'SNI_enabled' => true,
                'peer_name' => $host,
            ],
        ]);

        $errno = 0;
        $errstr = '';
        $target = format_connect_target($ip, $port);
        $fp = @stream_socket_client("{$scheme}{$target}", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
        if (!$fp) {
            throw new RuntimeException("IMAP connection failed ({$errno}): {$errstr}");
        }
        stream_set_timeout($fp, 20);
        $this->fp = $fp;

        try {
            $this->greeting = $this->readLine();
            if (!str_starts_with($this->greeting, '* OK')) {
                $this->broken = true;
                throw new RuntimeException('Unexpected IMAP greeting: ' . substr($this->greeting, 0, 120));
            }

            if ($tls === 'starttls') {
                $this->command('STARTTLS');
                if (!@stream_socket_enable_crypto($this->fp, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                    $this->broken = true;
                    throw new RuntimeException('IMAP STARTTLS negotiation failed.');
                }
            }

            $username = assert_no_crlf((string)($cfg['username'] ?? ''), 'username');
            $password = assert_no_crlf((string)($cfg['password'] ?? ''), 'password');
            $this->command('LOGIN ' . quote_imap($username) . ' ' . quote_imap($password));
        } catch (Throwable $e) {
            $this->broken = true;
            $this->close();
            throw $e;
        }
    }

    private function readLine(): string
    {
        $line = fgets($this->fp, 65536);
        if ($line === false) {
            $this->broken = true;
            throw new RuntimeException('IMAP socket closed or timed out.');
        }
        return rtrim($line, "\r\n");
    }

    private function readExact(int $len): string
    {
        $buf = '';
        while (strlen($buf) < $len) {
            $chunk = fread($this->fp, $len - strlen($buf));
            if ($chunk === false) {
                $this->broken = true;
                throw new RuntimeException('IMAP read error while reading literal.');
            }
            if ($chunk === '') {
                $meta = stream_get_meta_data($this->fp);
                if (!empty($meta['timed_out']) || !empty($meta['eof']) || feof($this->fp)) {
                    $this->broken = true;
                    throw new RuntimeException('IMAP connection closed or timed out while reading literal.');
                }
                continue;
            }
            $buf .= $chunk;
        }
        return $buf;
    }

    public function command(string $cmd): array
    {
        $tag = sprintf('P%04d', ++$this->tag);
        fwrite($this->fp, "{$tag} {$cmd}\r\n");
        $entries = [];

        while (true) {
            $line = $this->readLine();
            if (str_starts_with($line, "{$tag} ")) {
                $status = substr($line, strlen($tag) + 1);
                if (!str_starts_with($status, 'OK')) {
                    throw new RuntimeException('IMAP error: ' . substr($status, 0, 200));
                }
                return ['entries' => $entries, 'status' => $status];
            }

            $fullLine = $line;
            $entryLiterals = [];
            while (preg_match('/\{(\d+)\}$/', $fullLine, $m)) {
                $size = (int)$m[1];
                if ($size < 0 || $size > 26214400) {
                    $this->broken = true;
                    throw new RuntimeException('IMAP literal out of bounds.');
                }
                $entryLiterals[] = $this->readExact($size);
                $tail = $this->readLine();
                $fullLine .= "\n" . $tail;
                if (!preg_match('/\{(\d+)\}$/', $tail)) break;
            }
            $entries[] = ['line' => $fullLine, 'literals' => $entryLiterals];
        }
    }

    public function listMailboxes(): array
    {
        $res = $this->command('LIST "" "*"');
        $out = [];
        foreach ($res['entries'] as $entry) {
            $firstLine = explode("\n", $entry['line'], 2)[0] ?? '';
            if (preg_match('/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"((?:\\\\.|[^"\\\\])*)"|\{(\d+)\}|([^\s]+))$/i', $firstLine, $m)) {
                $flags = array_values(array_filter(preg_split('/\s+/', $m[1]) ?: []));
                $flagsLower = array_map('strtolower', $flags);
                $name = isset($m[4]) && $m[4] !== ''
                    ? ($entry['literals'][0] ?? '')
                    : str_replace(['\\"', '\\\\'], ['"', '\\'], $m[3] !== '' ? $m[3] : ($m[5] ?? ''));
                if ($name !== '' && !in_array('\\noselect', $flagsLower, true)) {
                    $out[] = ['name' => $name, 'flags' => $flags, 'delimiter' => $m[2] ?: '/'];
                }
            }
        }
        return $out;
    }

    public function fetchMessages(string $folder, int $limit = 30, int $page = 1): array
    {
        $safeFolder = assert_no_crlf(trim($folder) ?: 'INBOX', 'folder');
        $limit = max(1, min(60, $limit));
        $page = max(1, $page);

        $this->command('SELECT ' . quote_imap($safeFolder));
        $search = $this->command('UID SEARCH ALL');
        $allUids = [];
        foreach ($search['entries'] as $entry) {
            $line = $entry['line'];
            if (str_starts_with($line, '* SEARCH')) {
                $rest = trim(substr($line, 8));
                if ($rest !== '') {
                    foreach (preg_split('/\s+/', $rest) ?: [] as $u) {
                        if (ctype_digit($u) && (int)$u > 0) $allUids[] = (int)$u;
                    }
                }
            }
        }

        $total = count($allUids);
        if ($total === 0) return ['total' => 0, 'messages' => []];

        $newestFirst = array_reverse($allUids);
        $pageUids = array_slice($newestFirst, ($page - 1) * $limit, $limit);
        if ($pageUids === []) return ['total' => $total, 'messages' => []];

        $fetch = $this->command('UID FETCH ' . implode(',', $pageUids) . ' (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])');
        $messages = [];

        foreach ($fetch['entries'] as $entry) {
            $line = $entry['line'];
            if (!preg_match('/^\* \d+ FETCH /i', $line)) continue;
            $uid = preg_match('/\bUID (\d+)/i', $line, $um) ? (int)$um[1] : 0;
            $flags = preg_match('/\bFLAGS \(([^)]*)\)/i', $line, $fm)
                ? array_values(array_filter(preg_split('/\s+/', $fm[1]) ?: []))
                : [];
            $size = preg_match('/\bRFC822\.SIZE (\d+)/i', $line, $sm) ? (int)$sm[1] : 0;
            $internalDate = preg_match('/\bINTERNALDATE "([^"]+)"/i', $line, $dm) ? $dm[1] : '';

            $rawMime = '';
            foreach ($entry['literals'] as $lit) {
                if (strlen($lit) >= strlen($rawMime)) $rawMime = $lit;
            }
            $parsed = parse_mime_message($rawMime);

            $messages[] = array_merge([
                'uid' => $uid,
                'flags' => $flags,
                'size' => $size ?: strlen($rawMime),
                'internalDate' => $internalDate ?: $parsed['date'],
            ], $parsed);
        }

        usort($messages, static fn(array $a, array $b): int => $b['uid'] <=> $a['uid']);
        return ['total' => $total, 'messages' => $messages];
    }

    public function fetchSingle(string $folder, int $uid): ?array
    {
        $safeFolder = assert_no_crlf(trim($folder) ?: 'INBOX', 'folder');
        [$safeUid] = validate_uids([$uid]);
        $this->command('SELECT ' . quote_imap($safeFolder));
        $fetch = $this->command("UID FETCH {$safeUid} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])");
        foreach ($fetch['entries'] as $entry) {
            $line = $entry['line'];
            if (!preg_match('/^\* \d+ FETCH /i', $line)) continue;
            $rawMime = '';
            foreach ($entry['literals'] as $lit) {
                if (strlen($lit) >= strlen($rawMime)) $rawMime = $lit;
            }
            $flags = preg_match('/\bFLAGS \(([^)]*)\)/i', $line, $fm)
                ? array_values(array_filter(preg_split('/\s+/', $fm[1]) ?: []))
                : [];
            $size = preg_match('/\bRFC822\.SIZE (\d+)/i', $line, $sm) ? (int)$sm[1] : strlen($rawMime);
            $internalDate = preg_match('/\bINTERNALDATE "([^"]+)"/i', $line, $dm) ? $dm[1] : '';
            $parsed = parse_mime_message($rawMime);
            return array_merge([
                'uid' => $safeUid,
                'flags' => $flags,
                'size' => $size,
                'internalDate' => $internalDate ?: $parsed['date'],
                'raw' => $rawMime,
            ], $parsed);
        }
        return null;
    }

    public function updateFlags(string $folder, array $uids, string $op, array $flags): void
    {
        $safeFolder = assert_no_crlf(trim($folder) ?: 'INBOX', 'folder');
        $safeUids = validate_uids($uids);
        $allowed = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted'];
        $clean = array_values(array_intersect($flags, $allowed));
        if ($clean === []) throw new InvalidArgumentException('No valid IMAP flags specified.');
        $this->command('SELECT ' . quote_imap($safeFolder));
        $mode = $op === 'add' ? '+FLAGS.SILENT' : '-FLAGS.SILENT';
        $this->command('UID STORE ' . implode(',', $safeUids) . " {$mode} (" . implode(' ', $clean) . ')');
    }

    public function moveMessages(string $folder, array $uids, string $targetFolder): void
    {
        $safeFolder = assert_no_crlf(trim($folder) ?: 'INBOX', 'folder');
        $safeTarget = assert_no_crlf(trim($targetFolder), 'targetFolder');
        if ($safeTarget === '') throw new InvalidArgumentException('targetFolder must not be empty.');
        $safeUids = validate_uids($uids);
        $this->command('SELECT ' . quote_imap($safeFolder));
        $uidSet = implode(',', $safeUids);
        try {
            $this->command("UID MOVE {$uidSet} " . quote_imap($safeTarget));
        } catch (Throwable) {
            $this->command("UID COPY {$uidSet} " . quote_imap($safeTarget));
            $this->command("UID STORE {$uidSet} +FLAGS.SILENT (\\Deleted)");
            try {
                $this->command("UID EXPUNGE {$uidSet}");
            } catch (Throwable) {
                $this->command('EXPUNGE');
            }
        }
    }

    public function deleteMessages(string $folder, array $uids, bool $expunge = true): void
    {
        $safeFolder = assert_no_crlf(trim($folder) ?: 'INBOX', 'folder');
        $safeUids = validate_uids($uids);
        $uidSet = implode(',', $safeUids);
        $this->command('SELECT ' . quote_imap($safeFolder));
        $this->command("UID STORE {$uidSet} +FLAGS.SILENT (\\Deleted)");
        if ($expunge) {
            try {
                $this->command("UID EXPUNGE {$uidSet}");
            } catch (Throwable) {
                $this->command('EXPUNGE');
            }
        }
    }

    public function close(): void
    {
        if (!$this->broken && is_resource($this->fp)) {
            try {
                $this->command('LOGOUT');
            } catch (Throwable) {
                // ignore
            }
        }
        if (is_resource($this->fp)) {
            @fclose($this->fp);
            $this->fp = null;
        }
    }
}

function send_smtp(array $cfg, array $msg, bool $allowCustomPorts, bool $allowLocalTest): array
{
    $resolved = validate_host($cfg['host'] ?? '', $allowLocalTest);
    $host = $resolved['host'];
    $ip = $resolved['ip'];
    $port = validate_port($cfg['port'] ?? 465, $allowCustomPorts);
    $tls = (string)($cfg['tls'] ?? ($port === 465 ? 'tls' : 'starttls'));
    $scheme = $tls === 'tls' ? 'tls://' : 'tcp://';

    $fromEmail = validate_email($msg['fromEmail'] ?? '', 'fromEmail');
    $toList = array_map(static fn($a) => validate_email($a, 'to'), (array)($msg['to'] ?? []));
    $ccList = array_map(static fn($a) => validate_email($a, 'cc'), (array)($msg['cc'] ?? []));
    $bccList = array_map(static fn($a) => validate_email($a, 'bcc'), (array)($msg['bcc'] ?? []));
    $allRcpts = array_values(array_unique(array_merge($toList, $ccList, $bccList)));
    if ($allRcpts === []) {
        throw new InvalidArgumentException('At least one valid recipient is required.');
    }

    $username = assert_no_crlf((string)($cfg['username'] ?? ''), 'SMTP username');
    $password = assert_no_crlf((string)($cfg['password'] ?? ''), 'SMTP password');

    $context = stream_context_create([
        'ssl' => [
            'verify_peer' => !$allowLocalTest,
            'verify_peer_name' => !$allowLocalTest,
            'allow_self_signed' => $allowLocalTest,
            'SNI_enabled' => true,
            'peer_name' => $host,
        ],
    ]);

    $errno = 0;
    $errstr = '';
    $target = format_connect_target($ip, $port);
    $fp = @stream_socket_client("{$scheme}{$target}", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
    if (!$fp) {
        throw new RuntimeException("SMTP connection failed ({$errno}): {$errstr}");
    }
    stream_set_timeout($fp, 20);

    $readResp = static function () use ($fp): array {
        $lines = [];
        while (($line = fgets($fp, 65536)) !== false) {
            $clean = rtrim($line, "\r\n");
            $lines[] = $clean;
            if (!preg_match('/^(\d{3})(?:([ -]).*)?$/', $clean, $m)) {
                throw new RuntimeException('Malformed SMTP response.');
            }
            if (($m[2] ?? '') !== '-') {
                return [(int)$m[1], $lines];
            }
        }
        throw new RuntimeException('SMTP socket closed unexpectedly.');
    };

    $rawCmd = static function (string $c) use ($fp, $readResp): array {
        fwrite($fp, "{$c}\r\n");
        return $readResp();
    };

    $cmd = static function (string $c, array $expect) use ($rawCmd): array {
        [$code, $lines] = $rawCmd($c);
        if (!in_array($code, $expect, true)) {
            throw new RuntimeException("SMTP error ({$code}): " . substr(implode(' ', $lines), 0, 200));
        }
        return [$code, $lines];
    };

    try {
        [$greetCode] = $readResp();
        if ($greetCode !== 220) {
            throw new RuntimeException("Unexpected SMTP greeting ({$greetCode}).");
        }
        [, $ehloLines] = $cmd('EHLO [127.0.0.1]', [250]);

        if ($tls === 'starttls') {
            $cmd('STARTTLS', [220]);
            if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                throw new RuntimeException('SMTP STARTTLS failed.');
            }
            [, $ehloLines] = $cmd('EHLO [127.0.0.1]', [250]);
        }

        $ehloUpper = strtoupper(implode(' ', $ehloLines));
        $loginOnly = str_contains($ehloUpper, 'AUTH') && !str_contains($ehloUpper, 'PLAIN') && str_contains($ehloUpper, 'LOGIN');

        if ($loginOnly) {
            $cmd('AUTH LOGIN', [334]);
            $cmd(base64_encode($username), [334]);
            $cmd(base64_encode($password), [235]);
        } else {
            [$authCode, $authLines] = $rawCmd('AUTH PLAIN ' . base64_encode("\0{$username}\0{$password}"));
            if ($authCode !== 235) {
                if (in_array($authCode, [500, 502, 504], true)) {
                    $cmd('AUTH LOGIN', [334]);
                    $cmd(base64_encode($username), [334]);
                    $cmd(base64_encode($password), [235]);
                } else {
                    throw new RuntimeException("SMTP authentication failed ({$authCode}): " . substr(implode(' ', $authLines), 0, 200));
                }
            }
        }

        $cmd("MAIL FROM:<{$fromEmail}>", [250]);
        foreach ($allRcpts as $rcpt) {
            $cmd("RCPT TO:<{$rcpt}>", [250, 251]);
        }

        $cmd('DATA', [354]);
        $mime = build_outgoing_mime($msg, $fromEmail, $toList, $ccList);
        $normalized = preg_replace('/\r?\n/', "\r\n", $mime) ?? $mime;
        $stuffed = preg_replace('/(^|\r\n)\./', '$1..', $normalized) ?? $normalized;
        fwrite($fp, $stuffed . "\r\n.\r\n");
        [$dataCode, $dataLines] = $readResp();
        if ($dataCode !== 250) {
            throw new RuntimeException("SMTP DATA rejected ({$dataCode}).");
        }
        try {
            $cmd('QUIT', [221, 250]);
        } catch (Throwable) {
            // ignore
        }
        return ['ok' => true, 'serverResponse' => implode(' ', $dataLines)];
    } finally {
        @fclose($fp);
    }
}

function build_outgoing_mime(array $msg, string $fromEmail, array $toList, array $ccList): string
{
    $domain = explode('@', $fromEmail)[1] ?? 'neon-gmail.example';
    $msgId = '<' . bin2hex(random_bytes(8)) . '@' . $domain . '>';
    $formattedName = format_display_name((string)($msg['fromName'] ?? ''));
    $fromHeader = $formattedName !== '' ? "{$formattedName} <{$fromEmail}>" : "<{$fromEmail}>";
    $subject = encode_rfc2047((string)($msg['subject'] ?? '(No Subject)'));
    $boundaryAlt = '----=_NeonPhpAlt_' . bin2hex(random_bytes(6));
    $boundaryMix = '----=_NeonPhpMix_' . bin2hex(random_bytes(6));

    $headers = [
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        "Message-ID: {$msgId}",
        "From: {$fromHeader}",
        'To: ' . ($toList !== [] ? implode(', ', $toList) : 'undisclosed-recipients:;'),
    ];
    if ($ccList !== []) {
        $headers[] = 'Cc: ' . implode(', ', $ccList);
    }
    $headers[] = "Subject: {$subject}";
    if (!empty($msg['inReplyTo'])) {
        $headers[] = 'In-Reply-To: ' . assert_no_crlf((string)$msg['inReplyTo'], 'In-Reply-To');
    }
    if (!empty($msg['references'])) {
        $headers[] = 'References: ' . assert_no_crlf((string)$msg['references'], 'References');
    }
    $headers[] = 'MIME-Version: 1.0';
    $headers[] = 'X-Mailer: Neon Gmail PHP Proxy/1.0';

    $textB64 = rtrim(chunk_split(base64_encode((string)($msg['textBody'] ?? '')), 76, "\r\n"), "\r\n");
    $htmlBody = (string)($msg['htmlBody'] ?? '');
    $attachments = is_array($msg['attachments'] ?? null) ? $msg['attachments'] : [];

    if ($htmlBody !== '') {
        $htmlB64 = rtrim(chunk_split(base64_encode($htmlBody), 76, "\r\n"), "\r\n");
        $innerCt = "multipart/alternative; boundary=\"{$boundaryAlt}\"";
        $innerBody = "--{$boundaryAlt}\r\n"
            . "Content-Type: text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{$textB64}\r\n"
            . "--{$boundaryAlt}\r\n"
            . "Content-Type: text/html; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{$htmlB64}\r\n"
            . "--{$boundaryAlt}--";
    } else {
        $innerCt = "text/plain; charset=\"UTF-8\"\r\nContent-Transfer-Encoding: base64";
        $innerBody = $textB64;
    }

    if ($attachments === []) {
        $headers[] = "Content-Type: {$innerCt}";
        return implode("\r\n", $headers) . "\r\n\r\n{$innerBody}\r\n";
    }

    $headers[] = "Content-Type: multipart/mixed; boundary=\"{$boundaryMix}\"";
    $parts = ["--{$boundaryMix}\r\nContent-Type: {$innerCt}\r\n\r\n{$innerBody}"];
    foreach ($attachments as $att) {
        $fname = encode_rfc2047(str_replace(['"', '\\'], '_', assert_no_crlf((string)($att['filename'] ?? 'file.bin'), 'filename')));
        $rawType = trim(assert_no_crlf((string)($att['contentType'] ?? 'application/octet-stream'), 'contentType'));
        $ctype = preg_match('/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i', $rawType) ? $rawType : 'application/octet-stream';
        $data = rtrim(chunk_split(preg_replace('/\s+/', '', (string)($att['dataBase64'] ?? '')) ?? '', 76, "\r\n"), "\r\n");
        $parts[] = "--{$boundaryMix}\r\n"
            . "Content-Type: {$ctype}; name=\"{$fname}\"\r\n"
            . "Content-Disposition: attachment; filename=\"{$fname}\"\r\n"
            . "Content-Transfer-Encoding: base64\r\n\r\n{$data}";
    }
    $parts[] = "--{$boundaryMix}--";

    return implode("\r\n", $headers) . "\r\n\r\n" . implode("\r\n", $parts) . "\r\n";
}

function resolve_route(): string
{
    $action = $_GET['action'] ?? '';
    $map = [
        'health' => '/health',
        'test' => '/api/test',
        'imap_mailboxes' => '/api/imap/mailboxes',
        'imap_messages' => '/api/imap/messages',
        'imap_message' => '/api/imap/message',
        'imap_flags' => '/api/imap/flags',
        'imap_move' => '/api/imap/move',
        'imap_delete' => '/api/imap/delete',
        'smtp_send' => '/api/smtp/send',
    ];
    if (is_string($action) && isset($map[$action])) return $map[$action];

    $pathInfo = $_SERVER['PATH_INFO'] ?? '';
    if (is_string($pathInfo) && $pathInfo !== '') return rtrim($pathInfo, '/') ?: '/';

    $uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $scriptName = $_SERVER['SCRIPT_NAME'] ?? '';
    if ($scriptName !== '' && str_starts_with($uriPath, $scriptName)) {
        $uriPath = substr($uriPath, strlen($scriptName));
    }
    $uriPath = rtrim($uriPath, '/') ?: '/';
    return $uriPath === '/proxy.php' ? '/health' : $uriPath;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$route = resolve_route();

if ($method === 'GET' && ($route === '/' || $route === '/health')) {
    respond_json([
        'ok' => true,
        'service' => 'neon-gmail-proxy',
        'engine' => 'php',
        'phpVersion' => PHP_VERSION,
        'protocols' => ['imap', 'smtp'],
        'cors' => '*',
        'version' => '1.0.0',
    ]);
}

$expectedToken = getenv('NEON_PROXY_TOKEN');
if (is_string($expectedToken) && $expectedToken !== '') {
    $provided = $_SERVER['HTTP_X_PROXY_TOKEN'] ?? '';
    if (!is_string($provided) || !hash_equals($expectedToken, $provided)) {
        respond_json(['ok' => false, 'error' => 'Unauthorized: invalid or missing X-Proxy-Token.'], 401);
    }
}

if ($method !== 'POST') {
    respond_json(['ok' => false, 'error' => 'Method not allowed. Use POST.'], 405);
}

$rawBody = file_get_contents('php://input', false, null, 0, NEON_MAX_BODY_BYTES + 1);
if ($rawBody === false || strlen($rawBody) > NEON_MAX_BODY_BYTES) {
    respond_json(['ok' => false, 'error' => 'Request body too large (max 15 MB).'], 413);
}
$body = json_decode($rawBody, true);
if (!is_array($body)) {
    respond_json(['ok' => false, 'error' => 'Invalid JSON payload.'], 400);
}

$allowCustom = getenv('NEON_ALLOW_CUSTOM_PORT') === '1';
$allowLocal = getenv('NEON_ALLOW_LOCAL_TEST') === '1';

try {
    if ($route === '/api/test') {
        $started = microtime(true);
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $mailboxes = $client->listMailboxes();
            respond_json([
                'ok' => true,
                'greeting' => $client->greeting,
                'mailboxes' => $mailboxes,
                'latencyMs' => (int)round((microtime(true) - $started) * 1000),
            ]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/mailboxes') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            respond_json(['ok' => true, 'mailboxes' => $client->listMailboxes()]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/messages') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $res = $client->fetchMessages(
                (string)($body['folder'] ?? 'INBOX'),
                (int)($body['limit'] ?? 30),
                (int)($body['page'] ?? 1)
            );
            respond_json(array_merge(['ok' => true], $res));
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/message') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $msg = $client->fetchSingle((string)($body['folder'] ?? 'INBOX'), (int)($body['uid'] ?? 0));
            if ($msg === null) respond_json(['ok' => false, 'error' => 'Message not found.'], 404);
            respond_json(['ok' => true, 'message' => $msg]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/flags') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $client->updateFlags(
                (string)($body['folder'] ?? 'INBOX'),
                (array)($body['uids'] ?? []),
                (string)($body['op'] ?? 'add'),
                (array)($body['flags'] ?? [])
            );
            respond_json(['ok' => true]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/move') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $client->moveMessages(
                (string)($body['folder'] ?? 'INBOX'),
                (array)($body['uids'] ?? []),
                (string)($body['targetFolder'] ?? '')
            );
            respond_json(['ok' => true]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/imap/delete') {
        $client = new PhpImapClient((array)($body['imap'] ?? []), $allowCustom, $allowLocal);
        try {
            $client->deleteMessages(
                (string)($body['folder'] ?? 'INBOX'),
                (array)($body['uids'] ?? []),
                (bool)($body['expunge'] ?? true)
            );
            respond_json(['ok' => true]);
        } finally {
            $client->close();
        }
    }

    if ($route === '/api/smtp/send') {
        respond_json(send_smtp((array)($body['smtp'] ?? []), (array)($body['message'] ?? []), $allowCustom, $allowLocal));
    }

    respond_json(['ok' => false, 'error' => "Unknown endpoint: {$route}"], 404);
} catch (Throwable $e) {
    $safe = preg_replace('/[\r\n]+/', ' ', $e->getMessage()) ?? 'Proxy error';
    respond_json(['ok' => false, 'error' => substr($safe, 0, 300)], 400);
}
