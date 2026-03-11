// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock electron-log before importing service
vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

// Mock electron Notification
vi.mock('electron', () => ({
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn()
  }))
}))

// Mock settings service
const mockGetSetting = vi.fn()
const mockSetSetting = vi.fn()
vi.mock('./settings-service', () => ({
  settingsService: {
    getSetting: (...args: unknown[]) => mockGetSetting(...args),
    setSetting: (...args: unknown[]) => mockSetSetting(...args)
  }
}))

// Mock DB
const mockDbRows: Record<string, unknown[]> = {}
const mockInsertValues: unknown[] = []
const mockUpdateSets: unknown[] = []

const mockRun = vi.fn()
const mockGet = vi.fn()
const mockAll = vi.fn()

vi.mock('../db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: mockGet,
          all: mockAll
        }),
        orderBy: () => ({
          limit: () => ({
            offset: () => ({
              all: mockAll
            })
          })
        }),
        groupBy: () => ({
          all: mockAll
        })
      })
    }),
    insert: () => ({
      values: (vals: unknown) => {
        mockInsertValues.push(vals)
        return {
          run: mockRun,
          onConflictDoUpdate: () => ({
            run: mockRun
          })
        }
      }
    }),
    update: () => ({
      set: (vals: unknown) => {
        mockUpdateSets.push(vals)
        return {
          where: () => ({
            run: mockRun
          })
        }
      }
    }),
    delete: () => ({
      where: () => ({
        run: mockRun
      })
    })
  })
}))

vi.mock('../db/schema/secret-findings', () => ({
  secretFindings: {
    id: 'id',
    sourceFile: 'source_file',
    status: 'status',
    severity: 'severity',
    scannedAt: 'scanned_at',
    filePath: 'file_path'
  },
  secretScanState: {
    filePath: 'file_path'
  }
}))

import { secretScanService } from './secret-scan-service'

describe('secret-scan-service', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'secret-scan-test-'))
    vi.clearAllMocks()
    mockGet.mockReturnValue(undefined) // No existing scan state
    mockAll.mockReturnValue([])
    mockInsertValues.length = 0
    mockUpdateSets.length = 0
    secretScanService._isScanning = false
  })

  afterEach(async () => {
    secretScanService._isScanning = false
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('pattern detection', () => {
    it('detects Anthropic API keys', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'my key is sk-ant-api03-abc123def456ghijklmnop' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)

      // Check that insert was called with correct secret type
      const findingInsert = mockInsertValues.find(
        (v: any) => v.secretType === 'anthropic-api-key'
      )
      expect(findingInsert).toBeTruthy()
    })

    it('detects OpenAI API keys', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'key: sk-proj-abc123def456ghijklmnopqrstuv' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'openai-api-key')).toBe(true)
    })

    it('detects Google/Gemini API keys', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'key: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'google-api-key')).toBe(true)
    })

    it('detects AWS access keys', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'AWS key: AKIAIOSFODNN7EXAMPLE' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'aws-access-key')).toBe(true)
    })

    it('detects GitHub PATs', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkL' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'github-pat')).toBe(true)
    })

    it('detects JWT tokens', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: `Bearer ${jwt}` } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'jwt-token')).toBe(true)
    })

    it('detects connection strings', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'postgres://user:secret@localhost:5432/mydb' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'connection-string')).toBe(true)
    })

    it('detects private keys', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: '-----BEGIN RSA PRIVATE KEY-----' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBeGreaterThan(0)
      expect(mockInsertValues.some((v: any) => v.secretType === 'private-key')).toBe(true)
    })

    it('detects multiple secrets in one file (AC 9)', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl(
          { type: 'user', message: { content: `JWT: ${jwt}` } },
          { type: 'user', message: { content: 'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkL' } },
          { type: 'user', message: { content: 'db: postgres://user:pass@host/db' } }
        )
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBe(3)

      const types = mockInsertValues
        .filter((v: any) => v.secretType)
        .map((v: any) => v.secretType)
      expect(types).toContain('jwt-token')
      expect(types).toContain('github-pat')
      expect(types).toContain('connection-string')
    })

    it('does not match short/invalid patterns', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl(
          { type: 'user', message: { content: 'just some normal text' } },
          { type: 'user', message: { content: 'sk-short' } },
          { type: 'user', message: { content: 'AKIA1234' } } // too short for AWS key
        )
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.newFindings).toBe(0)
    })
  })

  describe('redacted preview generation', () => {
    it('generates first 4 + last 4 chars preview (AC 1)', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'sk-ant-api03-abc123def456ghij' } })
      })
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      await secretScanService.runScan()

      const findingInsert = mockInsertValues.find(
        (v: any) => v.secretType === 'anthropic-api-key'
      ) as any
      expect(findingInsert).toBeTruthy()
      // Preview should start with sk-a and end with last 4 chars
      expect(findingInsert.redactedPreview).toMatch(/^sk-a••••.{4}$/)
    })
  })

  describe('file filtering', () => {
    it('skips files modified today (AC 2)', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'sk-ant-api03-abc123def456ghij' } })
      }, false) // Don't backdate — keep as today
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      const result = await secretScanService.runScan()
      expect(result.filesScanned).toBe(0)
      expect(result.newFindings).toBe(0)
    })
  })

  describe('deduplication', () => {
    it('skips unchanged files on second scan (AC 3)', async () => {
      const claudeDir = await setupTestDir(tmpDir, {
        'test.jsonl': jsonl({ type: 'user', message: { content: 'sk-ant-api03-abc123def456ghij' } })
      })

      const filePath = join(claudeDir, 'projects', 'test-project', 'test.jsonl')
      const fileStat = await stat(filePath)

      // First scan
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'claude_dir') return claudeDir
        if (key === 'secret_scan_mode') return 'monitor'
        return null
      })

      await secretScanService.runScan()
      expect(mockInsertValues.length).toBeGreaterThan(0)

      // Second scan — mock scan state exists and matches
      mockGet.mockReturnValue({
        filePath,
        lastModifiedAt: fileStat.mtime.toISOString(),
        lastFileSize: fileStat.size
      })
      mockInsertValues.length = 0

      const result2 = await secretScanService.runScan()
      expect(result2.filesSkipped).toBe(1)
      expect(result2.filesScanned).toBe(0)
    })
  })

  describe('scanFile', () => {
    it('returns finding count for file with secrets', async () => {
      const filePath = join(tmpDir, 'test.jsonl')
      await writeFile(filePath, jsonl(
        { type: 'user', message: { content: 'key: sk-ant-api03-abc123def456ghij' } },
        { type: 'user', message: { content: 'AKIAIOSFODNN7EXAMPLE' } }
      ))

      // scanFile no longer depends on _isScanning (F07 fix)
      const count = await secretScanService.scanFile(filePath)
      expect(count).toBe(2)
    })

    it('returns 0 for file with no secrets', async () => {
      const filePath = join(tmpDir, 'clean.jsonl')
      await writeFile(filePath, jsonl(
        { type: 'user', message: { content: 'just some normal text' } }
      ))

      secretScanService._isScanning = true
      const count = await secretScanService.scanFile(filePath)
      expect(count).toBe(0)
    })
  })

  describe('context extraction', () => {
    it('captures surrounding chars with secret masked', async () => {
      const filePath = join(tmpDir, 'ctx.jsonl')
      await writeFile(filePath, jsonl(
        { type: 'user', message: { content: 'the api key is sk-ant-api03-abc123def456ghijklmnop and here is more text' } }
      ))

      await secretScanService.scanFile(filePath)

      const findingInsert = mockInsertValues.find(
        (v: any) => v.secretType === 'anthropic-api-key'
      ) as any
      expect(findingInsert).toBeTruthy()
      expect(findingInsert.context).toContain('[SECRET]')
    })
  })
})

// ===== Test Helpers =====

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

/**
 * Create a test claude directory structure with JSONL files.
 * By default, backdates files to yesterday so they're eligible for scanning.
 */
async function setupTestDir(
  baseDir: string,
  files: Record<string, string>,
  backdate = true
): Promise<string> {
  const claudeDir = join(baseDir, '.claude')
  const projectDir = join(claudeDir, 'projects', 'test-project')
  await mkdir(projectDir, { recursive: true })

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(projectDir, name)
    await writeFile(filePath, content)

    if (backdate) {
      // Set mtime to yesterday
      const yesterday = new Date(Date.now() - 86400000)
      await utimes(filePath, yesterday, yesterday)
    }
  }

  return claudeDir
}
