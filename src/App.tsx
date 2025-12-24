import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type WorkStatus = 'not-clocked' | 'working' | 'break' | 'out' | 'done';
type WorkLocation = 'office' | 'remote' | 'out';

type Employee = {
  id: string;
  name: string;
  role: string;
  avatarHue: number;
  employeeNumber: string;
  scheduledDailyMinutes: number;
  calendarUrl?: string;
};

type BreakSpan = { start: string; end?: string };

type Attendance = {
  date: string;
  employeeId: string;
  status: WorkStatus;
  location: WorkLocation;
  clockIn?: string;
  clockOut?: string;
  breaks: BreakSpan[];
  notes?: string;
};

type PersistedState = {
  employees: Employee[];
  attendance: Record<string, Attendance>;
  holidayUrl: string;
  companyHolidayUrl: string;
};

// freee集計の前提（要件）
const fixedWorkStart = '09:00';
const fixedWorkEnd = '18:00';
const fixedBreakMinutes = 90;
const defaultScheduledDailyMinutes = 540 - fixedBreakMinutes;

function normalizeEmployee(emp: Employee): Employee {
  return {
    ...emp,
    employeeNumber: (emp.employeeNumber ?? '').trim(),
    // 要件により所定は固定（9:00-18:00, 休憩1h30m）
    scheduledDailyMinutes: defaultScheduledDailyMinutes,
  };
}

function normalizeEmployees(employees: Employee[]): Employee[] {
  return employees.map((e) => normalizeEmployee(e));
}

const isUnsetEmployee = (emp: Employee) => (emp.name ?? '').trim() === '未設定';

function toPersistableState(input: PersistedState): PersistedState {
  // Validate employees to ensure no blank critical fields
  const employees = input.employees.map(emp => {
    const name = (emp.name ?? '').trim();
    const role = (emp.role ?? '').trim();
    
    // Ensure required fields are never completely blank
    return {
      ...emp,
      name: name || '未設定',
      role: role || '未設定',
      employeeNumber: (emp.employeeNumber ?? '').trim(),
      calendarUrl: (emp.calendarUrl ?? '').trim(),
    };
  });
  
  const allowedIds = new Set(employees.map((e) => e.id));
  const attendance: Record<string, Attendance> = {};
  for (const [k, v] of Object.entries(input.attendance)) {
    if (v && allowedIds.has(v.employeeId)) attendance[k] = v;
  }
  return { employees, attendance, holidayUrl: input.holidayUrl, companyHolidayUrl: input.companyHolidayUrl };
}

// Merge remote data with local - NEVER overwrite real data with placeholders or blanks
function mergeEmployeeData(remote: Employee, local: Employee | undefined): Employee {
  if (!local) return remote;
  
  const remoteName = (remote.name ?? '').trim();
  const localName = (local.name ?? '').trim();
  const remoteRole = (remote.role ?? '').trim();
  const localRole = (local.role ?? '').trim();
  const remoteNumber = (remote.employeeNumber ?? '').trim();
  const localNumber = (local.employeeNumber ?? '').trim();
  const remoteCalendar = (remote.calendarUrl ?? '').trim();
  const localCalendar = (local.calendarUrl ?? '').trim();
  
  // Helper to check if a value is "unset" or blank
  const isBlankOrUnset = (val: string) => !val || val === '未設定';
  
  return {
    ...remote,
    // Only use remote if it has real data AND local is blank/unset
    // Otherwise keep local to prevent data loss
    name: isBlankOrUnset(localName) ? remote.name : isBlankOrUnset(remoteName) ? local.name : remote.name,
    role: isBlankOrUnset(localRole) ? remote.role : isBlankOrUnset(remoteRole) ? local.role : remote.role,
    employeeNumber: isBlankOrUnset(localNumber) ? remote.employeeNumber : isBlankOrUnset(remoteNumber) ? local.employeeNumber : remote.employeeNumber,
    calendarUrl: isBlankOrUnset(localCalendar) ? remote.calendarUrl : isBlankOrUnset(remoteCalendar) ? local.calendarUrl : remote.calendarUrl,
  };
}

type CalendarEvent = {
  start: string;
  end?: string;
  summary?: string;
  location?: string;
};

const initialEmployees: Employee[] = [
  { id: 'emp-1', name: '未設定', role: '未設定', avatarHue: 160, employeeNumber: '', scheduledDailyMinutes: defaultScheduledDailyMinutes },
  { id: 'emp-2', name: '未設定', role: '未設定', avatarHue: 38, employeeNumber: '', scheduledDailyMinutes: defaultScheduledDailyMinutes },
  { id: 'emp-3', name: '未設定', role: '未設定', avatarHue: 32, employeeNumber: '', scheduledDailyMinutes: defaultScheduledDailyMinutes },
  { id: 'emp-4', name: '未設定', role: '未設定', avatarHue: 200, employeeNumber: '', scheduledDailyMinutes: defaultScheduledDailyMinutes },
  { id: 'emp-5', name: '未設定', role: '未設定', avatarHue: 0, employeeNumber: '', scheduledDailyMinutes: defaultScheduledDailyMinutes },
];

const defaultHolidayIcs =
  'https://www.google.com/calendar/ical/ja.japanese%23holiday%40group.v.calendar.google.com/public/basic.ics';

const remoteStateEndpoint = '/api/state';

const attendanceKey = (date: string, employeeId: string) => `${date}:${employeeId}`;

const nowIso = () => new Date().toISOString();
const todayKey = (date?: Date) => (date || new Date()).toISOString().slice(0, 10);

const formatTime = (iso?: string) => {
  if (!iso) return '--:--';
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const formatDateTime = (iso?: string) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const minutesBetween = (startIso?: string, endIso?: string) => {
  if (!startIso) return 0;
  const end = endIso ? new Date(endIso) : new Date();
  return Math.max(0, Math.round((end.getTime() - new Date(startIso).getTime()) / 60000));
};

const minutesToLabel = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}時間${m}分`;
};

const computeWorkedMinutes = (attendance: Attendance) => {
  if (!attendance.clockIn) return 0;
  const base = minutesBetween(attendance.clockIn, attendance.clockOut);
  const breakMinutes = attendance.breaks.reduce((sum, span) => sum + minutesBetween(span.start, span.end), 0);
  return Math.max(0, base - breakMinutes);
};

const statusLabelMap: Record<WorkStatus, string> = {
  'not-clocked': '未打刻',
  working: '出勤中',
  break: '休憩中',
  out: '外出中',
  done: '退勤済',
};

function cardStateClass(att: Attendance) {
  if (att.status === 'done') return 'card-state-done';
  if (att.status === 'not-clocked') return 'card-state-not-clocked';
  if (att.status === 'out' || att.status === 'break') return 'card-state-event';
  if (att.status === 'working' && att.location === 'remote') return 'card-state-working-remote';
  if (att.status === 'working' && att.location === 'office') return 'card-state-working-office';
  return 'card-state-not-clocked';
}

const statusToneMap: Record<WorkStatus, 'green' | 'yellow' | 'red' | 'gray'> = {
  working: 'green',
  break: 'yellow',
  out: 'yellow',
  done: 'gray',
  'not-clocked': 'red',
};

const locationLabel: Record<WorkLocation, string> = {
  office: 'オフィス',
  remote: 'テレワーク',
  out: '外出',
};

function buildInitialAttendanceForDate(employees: Employee[], date: string): Record<string, Attendance> {
  const base: Record<string, Attendance> = {};
  employees.forEach((emp) => {
    base[attendanceKey(date, emp.id)] = {
      date,
      employeeId: emp.id,
      status: 'not-clocked',
      location: 'office',
      breaks: [],
    };
  });
  return base;
}

function migrateAttendanceToDatedKeys(attendance: Record<string, Attendance> | undefined): Record<string, Attendance> {
  const next: Record<string, Attendance> = {};
  if (!attendance) return next;

  for (const [key, value] of Object.entries(attendance)) {
    if (!value || typeof value !== 'object') continue;
    if (key.includes(':')) {
      next[key] = value;
      continue;
    }
    // Legacy shape: keyed by employeeId only.
    const employeeId = value.employeeId ?? key;
    const date = value.date ?? todayKey();
    const datedKey = attendanceKey(date, employeeId);
    if (!next[datedKey]) {
      next[datedKey] = { ...value, employeeId, date };
    }
  }
  return next;
}

function ensureAttendanceForEmployeesForDate(
  employees: Employee[],
  attendance: Record<string, Attendance>,
  date: string,
): Record<string, Attendance> {
  const next: Record<string, Attendance> = { ...attendance };
  employees.forEach((emp) => {
    const key = attendanceKey(date, emp.id);
    if (!next[key]) {
      next[key] = {
        date,
        employeeId: emp.id,
        status: 'not-clocked',
        location: 'office',
        breaks: [],
      };
    }
  });
  return next;
}

function usePersistentState() {
  const lastSavedRef = useRef('');
  const saveTimerRef = useRef<number | undefined>(undefined);
  const pendingSaveRef = useRef(false);
  const lastLocalChangeAtRef = useRef<number>(0);
  const lastAppliedRemoteRef = useRef<string>('');
  const lastRemoteUpdatedAtRef = useRef<string | null>(null);
  const [remoteReady, setRemoteReady] = useState(false);
  const isInitialLoadRef = useRef(true);
  const remoteStorageAvailableRef = useRef(true); // Track if remote storage is available

  const LOCAL_STORAGE_KEY = 'attendance-app-state';

  const normalizePersisted = useCallback((parsed: PersistedState) => {
    const migrated = migrateAttendanceToDatedKeys(parsed.attendance);
    const today = todayKey();
    const employees = normalizeEmployees(parsed.employees);
    const companyHolidayUrl = (parsed as unknown as { companyHolidayUrl?: string }).companyHolidayUrl ?? '';
    return {
      employees,
      attendance: ensureAttendanceForEmployeesForDate(employees, migrated, today),
      holidayUrl: parsed.holidayUrl,
      companyHolidayUrl,
    } satisfies PersistedState;
  }, []);

  const loadRemote = useCallback(async () => {
    try {
      const res = await fetch(remoteStateEndpoint, { method: 'GET' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`Remote state GET failed: ${res.status} ${res.statusText}`, body);
        
        // Check if it's a Blob suspension error
        if (res.status === 500 && body.includes('suspended')) {
          console.error('Remote storage suspended. Falling back to localStorage only.');
          remoteStorageAvailableRef.current = false;
        }
        return;
      }
      const data = (await res.json()) as { state: PersistedState | null; updatedAt?: string };
      remoteStorageAvailableRef.current = true; // Mark as available if successful
      const remoteUpdatedAt = data?.updatedAt ?? null;
      if (remoteUpdatedAt && lastRemoteUpdatedAtRef.current && remoteUpdatedAt <= lastRemoteUpdatedAtRef.current) {
        return;
      }
      if (!data?.state) {
        lastRemoteUpdatedAtRef.current = remoteUpdatedAt;
        return;
      }

      const normalized = normalizePersisted(data.state);
      const serialized = JSON.stringify(toPersistableState(normalized));

      setState((prev) => {
        const prevSerialized = JSON.stringify(toPersistableState(prev));
        if (prevSerialized === serialized) return prev;
        
        // If we just saved this exact state to remote, don't reload it
        if (serialized === lastAppliedRemoteRef.current) return prev;
        
        // On first load, use remote data completely (don't merge with placeholder)
        if (isInitialLoadRef.current) {
          isInitialLoadRef.current = false;
          lastRemoteUpdatedAtRef.current = remoteUpdatedAt;
          lastAppliedRemoteRef.current = serialized;
          lastSavedRef.current = serialized;
          console.info('Initial remote data loaded');
          return normalized;
        }
        
        // If user is actively editing (within 2 seconds), defer the update
        if (Date.now() - lastLocalChangeAtRef.current < 2000) {
          console.info('Deferring remote update while user is editing');
          return prev;
        }

        // Merge employees intelligently - NEVER let blank/unset data overwrite real data
        const prevEmployeesById = new Map(prev.employees.map(e => [e.id, e]));
        const mergedEmployees = normalized.employees.map(remoteEmp => {
          const localEmp = prevEmployeesById.get(remoteEmp.id);
          // Skip merge if remote employee is completely unset/blank
          if (isUnsetEmployee(remoteEmp) && localEmp && !isUnsetEmployee(localEmp)) {
            return localEmp; // Keep local data when remote is just placeholder
          }
          return mergeEmployeeData(remoteEmp, localEmp);
        });
        
        // Add any local-only employees that aren't in remote (preserve all set employees)
        const remoteIds = new Set(normalized.employees.map(e => e.id));
        const localOnlyEmployees = prev.employees.filter(e => !remoteIds.has(e.id) && !isUnsetEmployee(e));
        
        const finalEmployees = [...mergedEmployees, ...localOnlyEmployees];
        const merged = { ...normalized, employees: finalEmployees };

        // Apply remote state - prioritize server data for cross-device sync
      remoteStorageAvailableRef.current = false;
        lastRemoteUpdatedAtRef.current = remoteUpdatedAt;
        lastAppliedRemoteRef.current = serialized;
        lastSavedRef.current = serialized;
        return merged;
      });
    } catch (err) {
      console.warn('Remote state unavailable:', err);
    } finally {
      setRemoteReady(true);
    }
  }, [normalizePersisted]);

  const scheduleRemoteSave = useCallback(
    (next: PersistedState) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      pendingSaveRef.current = true;
      saveTimerRef.current = window.setTimeout(async () => {
        try {
          const persistable = toPersistableState(next);
          
          // Validate before saving to prevent empty data
          if (!persistable.employees || persistable.employees.length === 0) {
            console.warn('Skipping save: no employees to save');
            return;
          }
          // Always save to localStorage as backup
          try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(persistable));
          } catch (localErr) {
            console.warn('localStorage save failed:', localErr);
          }
          
          // Skip remote save if storage is unavailable
          if (!remoteStorageAvailableRef.current) {
            console.info('Remote storage unavailable, saved to localStorage only');
            return;
          }
          
          const res = await fetch(remoteStateEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              state: persistable,
              lastKnownUpdatedAt: lastRemoteUpdatedAtRef.current // For optimistic locking
            }),
          });
          
          if (res.status === 409) {
            // Conflict detected - another client updated the state
            console.warn('Save conflict detected, reloading from server...');
            const conflictData = await res.json().catch(() => null);
            if (conflictData?.currentState) {
              // Reload the current state from server
              await loadRemote();
            }
            return;
          }
          
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn(`Remote state POST failed: ${res.status} ${res.statusText}`, body);
            
            // Check for Blob suspension
            if (res.status === 500 && body.includes('suspended')) {
              console.error('Remote storage suspended. Falling back to localStorage only.');
              remoteStorageAvailableRef.current = false;
            }
          } else {
            // Treat this state as the current remote snapshot to avoid echo loops.
            lastAppliedRemoteRef.current = JSON.stringify(persistable);
            try {
              const payload = (await res.json()) as { updatedAt?: string };
              if (payload?.updatedAt) lastRemoteUpdatedAtRef.current = payload.updatedAt;
            } catch {
              // ignore parse errors
            }
            console.info('State saved to remote storage');
          }
        } catch (err) {
          console.warn('Failed to save state to remote:', err);
          remoteStorageAvailableRef.current = false;
        } finally {
          pendingSaveRef.current = false;
        }
      }, 500);
    },
    [loadRemote],
  );

  const [state, setState] = useState<PersistedState>(() => {
    // Try to load from localStorage first
    const today = todayKey();
    
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as PersistedState;
        const normalized = {
          employees: normalizeEmployees(parsed.employees || []),
          attendance: parsed.attendance || {},
          holidayUrl: parsed.holidayUrl || defaultHolidayIcs,
          companyHolidayUrl: (parsed as any).companyHolidayUrl || '',
        };
        console.info('Loaded initial state from localStorage');
        lastSavedRef.current = stored;
        return normalized;
      }
    } catch (err) {
      console.warn('Failed to load from localStorage:', err);
    }
    
    // Fallback to initial placeholder employees
    const fallbackEmployees = normalizeEmployees(initialEmployees);
    const fallback: PersistedState = {
      employees: fallbackEmployees,
      attendance: buildInitialAttendanceForDate(fallbackEmployees, today),
      holidayUrl: defaultHolidayIcs,
      companyHolidayUrl: '',
    };
    lastSavedRef.current = JSON.stringify(toPersistableState(fallback));
    return fallback;
  });

  // Manual save function for immediate saves (attendance operations)
  const saveImmediately = useCallback(async (stateToSave: PersistedState) => {
    try {
      const persistable = toPersistableState(stateToSave);
      
      if (!persistable.employees || persistable.employees.length === 0) {
        console.warn('Skipping save: no employees to save');
        return;
      }
      
      // Always save to localStorage as backup
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(persistable));
      } catch (localErr) {
        console.warn('localStorage save failed:', localErr);
      }
      
      // Skip remote save if storage is unavailable
      if (!remoteStorageAvailableRef.current) {
        console.info('Remote storage unavailable, saved to localStorage only');
        return;
      }
      
      const res = await fetch(remoteStateEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          state: persistable,
          lastKnownUpdatedAt: lastRemoteUpdatedAtRef.current
        }),
      });
      
      if (res.status === 409) {
        console.warn('Save conflict detected, reloading from server...');
        await loadRemote();
        return;
      }
      
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`Remote state POST failed: ${res.status} ${res.statusText}`, body);
        
        // Check for Blob suspension
        if (res.status === 500 && body.includes('suspended')) {
          console.error('Remote storage suspended. Falling back to localStorage only.');
          remoteStorageAvailableRef.current = false;
        }
      } else {
        lastAppliedRemoteRef.current = JSON.stringify(persistable);
        try {
          const payload = (await res.json()) as { updatedAt?: string };
          if (payload?.updatedAt) lastRemoteUpdatedAtRef.current = payload.updatedAt;
        } catch {
          // ignore parse errors
        }
        console.info('State saved immediately to remote storage');
      }
    } catch (err) {
      console.warn('Failed to save state to remote:', err);
      remoteStorageAvailableRef.current = false;
    }
  }, [loadRemote]);

  // Track which parts of state should trigger auto-save
  const lastHolidayUrlRef = useRef(state.holidayUrl);
  const lastCompanyHolidayUrlRef = useRef(state.companyHolidayUrl);

  useEffect(() => {
    lastLocalChangeAtRef.current = Date.now();
    
    // Only auto-save for holiday URL changes (settings)
    const holidayUrlChanged = state.holidayUrl !== lastHolidayUrlRef.current;
    const companyHolidayUrlChanged = state.companyHolidayUrl !== lastCompanyHolidayUrlRef.current;
    
    if (holidayUrlChanged) lastHolidayUrlRef.current = state.holidayUrl;
    if (companyHolidayUrlChanged) lastCompanyHolidayUrlRef.current = state.companyHolidayUrl;
    
    if (!remoteReady) return;
    
    // Auto-save only for holiday URL changes
    if (holidayUrlChanged || companyHolidayUrlChanged) {
      scheduleRemoteSave(state);
    }
  }, [scheduleRemoteSave, state, remoteReady]);

  useEffect(() => {
    // Load shared state from server on boot.
    void loadRemote();
    // Sync when the tab becomes active.
    const onFocus = () => {
      if (pendingSaveRef.current) return;
      void loadRemote();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    // Poll every 10 seconds for cross-device sync (increased from 5s)
    const id = window.setInterval(() => {
      if (pendingSaveRef.current) return;
      void loadRemote();
    }, 10_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(id);
    };
  }, [loadRemote]);

  return [state, setState, saveImmediately] as const;
}

function parseIcsDate(raw: string) {
  if (!raw) return undefined;
  // All-day format
  if (/^\d{8}$/.test(raw)) {
    return new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00`);
  }

  // Date time format with optional Z. Treat without Z as local time, with Z as UTC.
  const dateTimeMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dateTimeMatch) {
    const [, y, m, d, hh, mm, ss, z] = dateTimeMatch;
    if (z) {
      return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    }
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed);
}

function pickNextAndCurrentEventFromIcs(text: string): { next: CalendarEvent | null; current: CalendarEvent | null } {
  const now = new Date();
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  let next: CalendarEvent | null = null;
  let current: CalendarEvent | null = null;

  blocks.forEach((block) => {
    const lines = block.split(/\r?\n/);
    const findLine = (key: string) => lines.find((l) => l.startsWith(key));
    const dtStartLine = findLine('DTSTART');
    if (!dtStartLine) return;
    const [, rawStart] = dtStartLine.split(':');
    const startDate = parseIcsDate(rawStart);
    if (!startDate || Number.isNaN(startDate.getTime())) return;
    const dtEndLine = findLine('DTEND');
    const [, rawEnd] = dtEndLine ? dtEndLine.split(':') : [];
    const endDate = rawEnd ? parseIcsDate(rawEnd) : undefined;
    const summaryLine = findLine('SUMMARY');
    const summary = summaryLine ? summaryLine.split(':').slice(1).join(':') : undefined;
    const locationLine = findLine('LOCATION');
    const location = locationLine ? locationLine.split(':').slice(1).join(':') : undefined;

    const startIso = startDate.toISOString();
    const endIso = endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : undefined;

    if (startDate <= now && (!endDate || endDate >= now)) {
      const candidate: CalendarEvent = { start: startIso, end: endIso, summary, location };
      if (!current || new Date(candidate.start) < new Date(current.start)) {
        current = candidate;
      }
      return;
    }

    if (startDate > now) {
      const candidate: CalendarEvent = { start: startIso, end: endIso, summary, location };
      if (!next || new Date(candidate.start) < new Date(next.start)) {
        next = candidate;
      }
    }
  });

  return { next, current };
}

const normalizeUrl = (url: string) => (url.startsWith('http') ? url : `https://${url}`);

const buildIcsProxyUrl = (targetUrl: string) => `/api/ics?url=${encodeURIComponent(targetUrl)}`;

function canonicalizeIcsUrl(raw: string) {
  const normalized = normalizeUrl(raw.trim());
  try {
    const u = new URL(normalized);
    if (u.pathname.includes('/calendar/embed')) {
      const src = u.searchParams.get('src');
      if (src) {
        return `https://calendar.google.com/calendar/ical/${encodeURIComponent(src)}/public/basic.ics`;
      }
    }
  } catch (err) {
    console.warn('invalid calendar url', raw, err);
  }
  return normalized;
}

function useEmployeeCalendars(employees: Employee[], refreshKey: number) {
  const [nextEvents, setNextEvents] = useState<Record<string, CalendarEvent | null>>({});
  const [currentEvents, setCurrentEvents] = useState<Record<string, CalendarEvent | null>>({});
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');

  // In-memory cache to reduce API calls
  const cacheRef = useRef<Map<string, { text: string; timestamp: number }>>(new Map());
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  const fetchIcsText = useCallback(async (url: string) => {
    // Validate URL before processing
    if (!url || !url.trim()) {
      throw new Error('Empty calendar URL');
    }

    const target = canonicalizeIcsUrl(url);
    
    // Check cache first
    const cached = cacheRef.current.get(target);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('Using cached ICS for', target);
      return cached.text;
    }

    const candidates = [
      // Same-origin proxy avoids browser CORS issues.
      buildIcsProxyUrl(target),
      // Fallback to direct (may fail on CORS but kept as last resort)
      target,
    ];

    let lastErr: unknown = null;
    for (let i = 0; i < candidates.length; i++) {
      const endpoint = candidates[i];
      try {
        // Add timeout to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const res = await fetch(endpoint, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
        const text = await res.text();
        if (!text.trim()) throw new Error('ICS empty response');
        
        // Cache successful result
        cacheRef.current.set(target, { text, timestamp: Date.now() });
        return text;
      } catch (err) {
        lastErr = err;
        const errorName = err instanceof Error ? err.name : 'Unknown';
        console.warn(`ICS fetch failed candidate ${i + 1}/${candidates.length}:`, endpoint, errorName);
        
        // Don't retry on timeout for direct URL (last candidate)
        if (errorName === 'AbortError' && i === candidates.length - 1) {
          break;
        }
      }
    }
    throw lastErr ?? new Error('ICS fetch failed');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setStatus('loading');
      const nextMap: Record<string, CalendarEvent | null> = {};
      const currentMap: Record<string, CalendarEvent | null> = {};
      
      // Process all employees in parallel for better performance
      const results = await Promise.allSettled(
        employees.map(async (emp) => {
          // Skip if calendar URL is not set or empty
          if (!emp.calendarUrl || !emp.calendarUrl.trim()) {
            return { id: emp.id, next: null, current: null };
          }
          try {
            const text = await fetchIcsText(emp.calendarUrl);
            const { next, current } = pickNextAndCurrentEventFromIcs(text);
            return { id: emp.id, next, current };
          } catch (err) {
            // Only log error if it's not an empty URL error
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!errMsg.includes('Empty calendar URL')) {
              console.warn(`Calendar fetch error for ${emp.name}:`, err);
            }
            return { id: emp.id, next: null, current: null };
          }
        })
      );

      // Process results
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { id, next, current } = result.value;
          nextMap[id] = next;
          currentMap[id] = current;
        } else {
          // Fallback for unexpected errors
          const emp = employees[index];
          nextMap[emp.id] = null;
          currentMap[emp.id] = null;
        }
      });

      if (!cancelled) {
        setNextEvents(nextMap);
        setCurrentEvents(currentMap);
        setStatus('idle');
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [employees, refreshKey, fetchIcsText]);

  return { nextEvents, currentEvents, status };
}

type HolidayState = { dates: Set<string>; status: 'idle' | 'loading' | 'error' };

function parseHolidayDatesFromIcs(text: string): Set<string> {
  const toLocalDateKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const addDateRange = (start: Date, endExclusive: Date) => {
    const dates: string[] = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(endExclusive);
    end.setHours(0, 0, 0, 0);
    while (cursor < end) {
      dates.push(toLocalDateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  };

  const result = new Set<string>();
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const findLine = (prefix: string) => lines.find((l) => l.startsWith(prefix));

    const dtStartLine = findLine('DTSTART');
    if (!dtStartLine) continue;
    const startRaw = dtStartLine.split(':').slice(1).join(':');
    const startDate = parseIcsDate(startRaw);
    if (!startDate || Number.isNaN(startDate.getTime())) continue;

    const dtEndLine = findLine('DTEND');
    const endRaw = dtEndLine ? dtEndLine.split(':').slice(1).join(':') : '';
    const endDate = endRaw ? parseIcsDate(endRaw) : undefined;

    const isAllDayStart = /^\d{8}$/.test(startRaw);
    const isAllDayEnd = /^\d{8}$/.test(endRaw);

    if (isAllDayStart && endDate && isAllDayEnd) {
      // All-day DTEND is typically exclusive in ICS.
      for (const key of addDateRange(startDate, endDate)) result.add(key);
      continue;
    }

    // Fallback: treat the DTSTART day as a holiday.
    result.add(toLocalDateKey(startDate));
  }
  return result;
}

function useHolidayFeed(url: string) {
  const [holidayState, setHolidayState] = useState<HolidayState>({ dates: new Set(), status: 'idle' });
  const cacheRef = useRef<Map<string, { dates: Set<string>; timestamp: number }>>(new Map());
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours for holidays

  useEffect(() => {
    if (!url || !url.trim()) {
      setHolidayState({ dates: new Set(), status: 'idle' });
      return;
    }

    const fetchHolidays = async () => {
      const target = canonicalizeIcsUrl(url);
      
      // Check cache first (holidays don't change frequently)
      const cached = cacheRef.current.get(target);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('Using cached holiday data');
        setHolidayState({ dates: cached.dates, status: 'idle' });
        return;
      }

      setHolidayState({ dates: new Set(), status: 'loading' });
      
      try {
        const candidates = [
          // Same-origin proxy avoids browser CORS issues.
          buildIcsProxyUrl(target),
          target,
        ];
        let lastErr: unknown = null;
        let text = '';
        
        for (let i = 0; i < candidates.length; i++) {
          const endpoint = candidates[i];
          try {
            // Add timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for holidays

            const res = await fetch(endpoint, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
            text = await res.text();
            if (!text.trim()) throw new Error('ICS empty response');
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            const errorName = err instanceof Error ? err.name : 'Unknown';
            console.warn(`Holiday ICS fetch failed candidate ${i + 1}/${candidates.length}:`, endpoint, errorName);
          }
        }
        
        if (lastErr) throw lastErr;
        
        const dates = parseHolidayDatesFromIcs(text);
        
        // Cache the result
        cacheRef.current.set(target, { dates, timestamp: Date.now() });
        
        setHolidayState({ dates, status: 'idle' });
      } catch (err) {
        console.error('Holiday fetch error:', err);
        // Use cached data if available, even if expired
        const cached = cacheRef.current.get(target);
        if (cached) {
          console.log('Using stale cached holiday data due to fetch error');
          setHolidayState({ dates: cached.dates, status: 'idle' });
        } else {
          setHolidayState({ dates: new Set(), status: 'error' });
        }
      }
    };

    fetchHolidays();
  }, [url]);

  return holidayState;
}

function App() {
  const [state, setState, saveImmediately] = usePersistentState();
  const [view, setView] = useState<'dashboard' | 'monthly' | 'settings'>('dashboard');
  const [calendarTick, setCalendarTick] = useState(0);
  const [pendingEmployeeChanges, setPendingEmployeeChanges] = useState(false);
  const holidayState = useHolidayFeed(state.holidayUrl);
  const companyHolidayState = useHolidayFeed(state.companyHolidayUrl);
  const { nextEvents, currentEvents, status: calendarStatus } = useEmployeeCalendars(state.employees, calendarTick);

  useEffect(() => {
    // Refresh calendar events every minute
    const id = setInterval(() => {
      setCalendarTick((tick) => tick + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto clock-out at midnight (24:00 / 00:00)
  useEffect(() => {
    const checkAndAutoClockOut = () => {
      const now = new Date();
      const currentDate = todayKey();
      
      // Check if it's midnight (00:00 to 00:05)
      if (now.getHours() === 0 && now.getMinutes() < 5) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayKey = todayKey(yesterday);
        
        setState((prev) => {
          const migrated = migrateAttendanceToDatedKeys(prev.attendance);
          const updated = { ...migrated };
          let hasChanges = false;

          // Auto clock-out any employees who were still working yesterday
          prev.employees.forEach((emp) => {
            const key = attendanceKey(yesterdayKey, emp.id);
            const att = migrated[key];
            
            if (att && (att.status === 'working' || att.status === 'break' || att.status === 'out') && !att.clockOut) {
              // Set clock-out to 23:59:59 of yesterday
              const midnightTime = new Date(yesterday);
              midnightTime.setHours(23, 59, 59, 0);
              
              // Close any open breaks
              const breaks = att.breaks.map((b) => 
                b.end ? b : { ...b, end: midnightTime.toISOString() }
              );
              
              updated[key] = {
                ...att,
                status: 'done',
                clockOut: midnightTime.toISOString(),
                breaks,
              };
              hasChanges = true;
              console.log(`Auto clock-out at midnight for ${emp.name}`);
            }
          });

          if (hasChanges) {
            return { ...prev, attendance: updated };
          }
          return prev;
        });
      }
    };

    // Check every minute
    const id = setInterval(checkAndAutoClockOut, 60_000);
    // Also check immediately
    checkAndAutoClockOut();
    
    return () => clearInterval(id);
  }, [setState]);

  const today = todayKey();
  const [selectedMonth, setSelectedMonth] = useState(() => today.slice(0, 7));
  const attendanceList: Attendance[] = useMemo(
    () =>
      state.employees.map((emp) => {
        const key = attendanceKey(today, emp.id);
        const att = state.attendance[key];
        if (att) return att;
        return {
          date: today,
          employeeId: emp.id,
          status: 'not-clocked',
          location: 'office' as WorkLocation,
          breaks: [],
        };
      }),
    [state.attendance, state.employees, today],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<WorkStatus, number> = {
      working: 0,
      break: 0,
      out: 0,
      done: 0,
      'not-clocked': 0,
    };
    attendanceList.forEach((att) => {
      counts[att.status] += 1;
    });
    return counts;
  }, [attendanceList]);

  const totalMinutes = attendanceList.reduce((sum, att) => sum + computeWorkedMinutes(att), 0);

  const updateAttendance = (employeeId: string, updater: (prev: Attendance) => Attendance) => {
    setState((prev) => {
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      const nextAttendance = ensureAttendanceForEmployeesForDate(prev.employees, migrated, today);
      const key = attendanceKey(today, employeeId);
      const newState = {
        ...prev,
        attendance: {
          ...nextAttendance,
          [key]: updater(nextAttendance[key]),
        },
      };
      // Save immediately after attendance update
      void saveImmediately(newState);
      return newState;
    });
  };

  const handleClockIn = (employeeId: string, location: WorkLocation) => {
    updateAttendance(employeeId, (prev) => ({
      ...prev,
      date: today,
      location,
      status: location === 'out' ? 'out' : 'working',
      clockIn: prev.clockIn ?? nowIso(),
      clockOut: undefined,
      breaks: [],
    }));
  };

  const handleClockOut = (employeeId: string) => {
    updateAttendance(employeeId, (prev) => ({
      ...prev,
      date: today,
      status: 'done',
      clockOut: nowIso(),
    }));
  };

  const handleBreakToggle = (employeeId: string) => {
    updateAttendance(employeeId, (prev) => {
      if (prev.status === 'break') {
        const breaks = [...prev.breaks];
        const last = breaks[breaks.length - 1];
        if (last && !last.end) {
          breaks[breaks.length - 1] = { ...last, end: nowIso() };
        }
        return { ...prev, status: 'working', breaks };
      }
      return { ...prev, status: 'break', breaks: [...prev.breaks, { start: nowIso() }] };
    });
  };

  const handleOutToggle = (employeeId: string) => {
    updateAttendance(employeeId, (prev) => {
      if (prev.status === 'out') {
        return { ...prev, status: 'working' };
      }
      return { ...prev, status: 'out', location: 'out' };
    });
  };

  const monthAttendanceByEmployee = useMemo(() => {
    const prefix = `${selectedMonth}-`;
    const records = Object.values(state.attendance).filter((att) => att.date.startsWith(prefix));
    const byEmployee: Record<string, Attendance[]> = {};
    records.forEach((att) => {
      if (!byEmployee[att.employeeId]) byEmployee[att.employeeId] = [];
      byEmployee[att.employeeId].push(att);
    });
    for (const key of Object.keys(byEmployee)) {
      byEmployee[key].sort((a, b) => a.date.localeCompare(b.date));
    }
    return byEmployee;
  }, [state.attendance, selectedMonth]);

  const exportMonthlyCsv = () => {
    const freeeHeaders = [
      '従業員番号',
      '氏名',
      '所定労働時間（分）',
      '法定内残業時間（分）',
      '時間外労働時間（分）',
      '所定休日労働時間（分）',
      '深夜労働時間（分）',
      '法定休日労働時間（分）',
      '総労働時間（分）',
      '総労働日数',
      '所定労働出勤日数',
      '所定休日出勤日数',
      '法定休日出勤日数',
      '遅刻時間（分）',
      '早退時間（分）',
      '欠勤日数',
      '遅刻日数',
      '早退日数',
      '有休取得日数',
      '集計開始日',
      '集計終了日',
      'みなし外の法定内残業時間（分）',
      'みなし外の時間外労働時間（分）',
      '不足時間（分）',
    ];

    const csvEscape = (value: string | number | null | undefined) => {
      const raw = value === null || value === undefined ? '' : String(value);
      if (raw.includes('"') || raw.includes(',') || raw.includes('\n') || raw.includes('\r')) {
        return `"${raw.replaceAll('"', '""')}"`;
      }
      return raw;
    };

    const monthStart = new Date(`${selectedMonth}-01T00:00:00`);
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    monthEnd.setDate(0);
    monthEnd.setHours(0, 0, 0, 0);

    const toDateKey = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const formatYmdSlash = (dateKey: string) => {
      const [y, m, d] = dateKey.split('-').map((v) => Number(v));
      return `${y}/${m}/${d}`;
    };

    const isScheduledWorkday = (dateKey: string) => {
      const date = new Date(`${dateKey}T00:00:00`);
      const dow = date.getDay();
      if (dow === 0 || dow === 6) return false;
      if (holidayState.dates.has(dateKey)) return false;
      if (companyHolidayState.dates.has(dateKey)) return false;
      return true;
    };

    const overlapMinutes = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => {
      const start = Math.max(aStart.getTime(), bStart.getTime());
      const end = Math.min(aEnd.getTime(), bEnd.getTime());
      if (end <= start) return 0;
      return (end - start) / 60000;
    };

    const subtractInterval = (interval: [Date, Date], cut: [Date, Date]) => {
      const [s, e] = interval;
      const [cs, ce] = cut;
      if (ce <= s || cs >= e) return [interval];
      const out: Array<[Date, Date]> = [];
      const leftEnd = new Date(Math.min(cs.getTime(), e.getTime()));
      if (leftEnd > s) out.push([s, leftEnd]);
      const rightStart = new Date(Math.max(ce.getTime(), s.getTime()));
      if (e > rightStart) out.push([rightStart, e]);
      return out;
    };

    const computeWorkIntervals = (att: Attendance): Array<[Date, Date]> => {
      if (!att.clockIn) return [];
      const start = new Date(att.clockIn);
      const end = new Date(att.clockOut ?? nowIso());
      if (!(end > start)) return [];
      let intervals: Array<[Date, Date]> = [[start, end]];
      for (const b of att.breaks) {
        if (!b?.start) continue;
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end ?? nowIso());
        if (!(bEnd > bStart)) continue;
        intervals = intervals.flatMap((iv) => subtractInterval(iv, [bStart, bEnd]));
        if (intervals.length === 0) break;
      }
      return intervals.filter(([s, e]) => e > s);
    };

    const computeNightMinutes = (att: Attendance) => {
      const intervals = computeWorkIntervals(att);
      let total = 0;
      for (const [start, end] of intervals) {
        const cursor = new Date(start);
        cursor.setHours(0, 0, 0, 0);
        while (cursor < end) {
          const dayStart = new Date(cursor);
          const nextDayStart = new Date(dayStart);
          nextDayStart.setDate(nextDayStart.getDate() + 1);

          const night1Start = new Date(dayStart);
          night1Start.setHours(0, 0, 0, 0);
          const night1End = new Date(dayStart);
          night1End.setHours(5, 0, 0, 0);

          const night2Start = new Date(dayStart);
          night2Start.setHours(22, 0, 0, 0);
          const night2End = new Date(nextDayStart);

          total += overlapMinutes(start, end, night1Start, night1End);
          total += overlapMinutes(start, end, night2Start, night2End);

          cursor.setDate(cursor.getDate() + 1);
          cursor.setHours(0, 0, 0, 0);
        }
      }
      return Math.round(total);
    };

    let scheduledWorkdayCount = 0;
    for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
      if (isScheduledWorkday(toDateKey(d))) scheduledWorkdayCount += 1;
    }

    const employees = state.employees.filter((e) => !isUnsetEmployee(e));
    const lines = employees.map((emp) => {
      const items = monthAttendanceByEmployee[emp.id] ?? [];

      const workedByDay = new Map<string, { workedMinutes: number; nightMinutes: number }>();
      for (const att of items) {
        // freee集計は「休憩1h30m固定」。打刻が揃っていない日は集計から除外。
        const workedMinutes = att.clockIn && att.clockOut ? Math.max(0, minutesBetween(att.clockIn, att.clockOut) - fixedBreakMinutes) : 0;
        const nightMinutes = computeNightMinutes(att);
        const prev = workedByDay.get(att.date);
        if (!prev) {
          workedByDay.set(att.date, { workedMinutes, nightMinutes });
        } else {
          workedByDay.set(att.date, {
            workedMinutes: prev.workedMinutes + workedMinutes,
            nightMinutes: prev.nightMinutes + nightMinutes,
          });
        }
      }

      let totalWorkMinutes = 0;
      let totalNightMinutes = 0;
      let totalWorkDays = 0;
      let scheduledWorkAttendanceDays = 0;
      let prescribedHolidayAttendanceDays = 0;
      let legalHolidayAttendanceDays = 0;

      for (const [dateKey, day] of workedByDay.entries()) {
        if (day.workedMinutes <= 0) continue;
        totalWorkMinutes += day.workedMinutes;
        totalNightMinutes += day.nightMinutes;
        totalWorkDays += 1;

        const date = new Date(`${dateKey}T00:00:00`);
        const dow = date.getDay();
        const scheduled = isScheduledWorkday(dateKey);
        if (scheduled) scheduledWorkAttendanceDays += 1;
        else if (dow === 0) legalHolidayAttendanceDays += 1;
        else prescribedHolidayAttendanceDays += 1;
      }

      const scheduledWorkMinutes = defaultScheduledDailyMinutes * scheduledWorkdayCount;
      const overtimeMinutes = Math.max(0, totalWorkMinutes - scheduledWorkMinutes);
      const shortageMinutes = Math.max(0, scheduledWorkMinutes - totalWorkMinutes);

      const startKey = toDateKey(monthStart);
      const endKey = toDateKey(monthEnd);

      const row = [
        emp.employeeNumber ?? '',
        emp.name,
        scheduledWorkMinutes,
        '',
        overtimeMinutes,
        '',
        totalNightMinutes,
        '',
        totalWorkMinutes,
        totalWorkDays,
        scheduledWorkAttendanceDays,
        prescribedHolidayAttendanceDays,
        legalHolidayAttendanceDays,
        '',
        '',
        '',
        '',
        '',
        '',
        formatYmdSlash(startKey),
        formatYmdSlash(endKey),
        '',
        '',
        shortageMinutes,
      ];
      return row.map((v) => csvEscape(v)).join(',');
    });

    const csv = [freeeHeaders.map((h) => csvEscape(h)).join(','), ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `freee-attendance-${selectedMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isHoliday = holidayState.dates.has(today) || companyHolidayState.dates.has(today);

  const updateEmployeeField = (id: string, field: 'name' | 'role' | 'calendarUrl', value: string) => {
    setPendingEmployeeChanges(true);
    setState((prev) => {
      const employees = prev.employees.map((emp) => {
        if (emp.id !== id) return emp;
        const trimmedValue = (value ?? '').trim();
        const currentValue = (emp[field] ?? '').trim();
        
        // CRITICAL: Never overwrite real data with blank or "未設定"
        if ((field === 'name' || field === 'role')) {
          // If trying to set blank or "未設定", keep existing value if it's set
          if ((trimmedValue === '' || trimmedValue === '未設定') && currentValue !== '' && currentValue !== '未設定') {
            return emp;
          }
        }
        
        // For calendar URL, allow clearing but prevent accidental blanking
        if (field === 'calendarUrl' && trimmedValue === '' && currentValue !== '') {
          // Only allow clearing if explicitly intended (keep the update)
        }
        
        return { ...emp, [field]: value };
      });
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      return { ...prev, employees, attendance: ensureAttendanceForEmployeesForDate(employees, migrated, todayKey()) };
    });
  };

  const updateEmployeeNumber = (id: string, value: string) => {
    setPendingEmployeeChanges(true);
    setState((prev) => {
      const employees = prev.employees.map((emp) => {
        if (emp.id !== id) return emp;
        const trimmedValue = (value ?? '').trim();
        const currentValue = (emp.employeeNumber ?? '').trim();
        
        // Prevent overwriting set employee number with blank
        if (trimmedValue === '' && currentValue !== '') {
          return emp;
        }
        
        return { ...emp, employeeNumber: value };
      });
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      return { ...prev, employees, attendance: ensureAttendanceForEmployeesForDate(employees, migrated, todayKey()) };
    });
  };


  const addEmployee = () => {
    setPendingEmployeeChanges(true);
    const newId = `emp-${Date.now()}`;
    const newEmployee: Employee = {
      id: newId,
      name: '新規メンバー',
      role: '役割',
      avatarHue: Math.floor(Math.random() * 360),
      employeeNumber: '',
      scheduledDailyMinutes: defaultScheduledDailyMinutes,
      calendarUrl: '',
    };
    setState((prev) => {
      const employees = [...prev.employees, newEmployee];
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      const attendance = ensureAttendanceForEmployeesForDate(employees, migrated, todayKey());
      return { ...prev, employees, attendance };
    });
  };

  const saveEmployeeSettings = async () => {
    await saveImmediately(state);
    setPendingEmployeeChanges(false);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="app-date">{today}</p>
          <h1 className="app-title">勤怠ダッシュボード</h1>
          {isHoliday && <span className="holiday-chip">本日はカレンダー上の休日です</span>}
        </div>
        <div className="header-actions">
          <div className="segmented">
            <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>
              ダッシュボード
            </button>
            <button className={view === 'monthly' ? 'active' : ''} onClick={() => setView('monthly')}>
              月次出力/閲覧
            </button>
            <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
              従業員管理
            </button>
          </div>
        </div>
      </header>

      {view === 'dashboard' && (
        <>
          <section className="summary-cards">
            <SummaryCard label="出勤中" value={statusCounts.working} tone="green" />
            <SummaryCard label="休憩/外出" value={statusCounts.break + statusCounts.out} tone="yellow" />
            <SummaryCard label="未打刻" value={statusCounts['not-clocked']} tone="red" />
            <SummaryCard label="退勤済" value={statusCounts.done} tone="gray" />
          </section>

          <section className="cards-grid">
            {state.employees.map((emp) => {
              const attFound = attendanceList.find((a) => a.employeeId === emp.id);
              const fallbackAtt: Attendance = {
                date: today,
                employeeId: emp.id,
                status: 'not-clocked',
                location: 'office',
                breaks: [],
              };
              const att: Attendance = attFound ?? fallbackAtt;
              const workedMinutes = computeWorkedMinutes(att);
              const nextEvent = nextEvents[emp.id];
              const currentEvent = currentEvents[emp.id];
              return (
                <article key={emp.id} className={`card ${cardStateClass(att)}`}>
                  <div className="card-row-top">
                    <div className="avatar" style={{ background: `hsl(${emp.avatarHue} 55% 75%)` }} />
                    <p className="card-name"  style={{ fontSize: '24px' }}>{emp.name}</p>
                    <p className="card-role">{emp.role}</p>
                    <p className="label">場所:</p>
                    <p className="value subtle" style={{ fontSize: '24px' }}>{locationLabel[att.location]}</p>
                    <span className={`status-pill ${statusToneMap[att.status]}`}>{statusLabelMap[att.status]}</span>
                    <div className="card-info-item">
                      <p className="label">出勤:</p>
                      <p className="value">{formatTime(att.clockIn)}</p>
                    </div>
                    <div className="card-info-item" style={{ fontSize: '18px' }}>
                      <p className="label">勤務:</p>
                      <p className="value">{minutesToLabel(workedMinutes)}</p>
                    </div>
                    
                    <button onClick={() => handleClockIn(emp.id, 'office')} disabled={att.status === 'working'} style={{ fontSize: '24px' }}>
                      出勤(オフィス)
                    </button>
                    <button onClick={() => handleClockIn(emp.id, 'remote')} disabled={att.status === 'working'} style={{ fontSize: '24px' }}>
                      出勤(テレワーク)
                    </button>
                  </div>

                  <div className="card-row-bottom"  style={{ fontSize: '20px' }}>
                    <div className="next-event">
                      <span className="label">現在:</span>
                      <span className="value" style={{ fontSize: '20px' }}>
                        {currentEvent ? (
                          <>
                            {formatDateTime(currentEvent.start)}
                            {currentEvent.end && `-${formatDateTime(currentEvent.end)}`}
                            <br />
                            {currentEvent.summary || '(タイトルなし)'}
                          </>
                        ) : emp.calendarUrl ? (
                          'なし'
                        ) : (
                          '未設定'
                        )}
                      </span>
                    </div>
                    <div className="next-event" style={{ fontSize: '20px' }}>
                      <span className="label">次:</span>
                      <span className="value" style={{ fontSize: '20px' }}>
                        {nextEvent ? (
                          <>
                            {formatDateTime(nextEvent.start)}
                            {nextEvent.end && `-${formatDateTime(nextEvent.end)}`}
                            <br />
                            {nextEvent.summary || '(タイトルなし)'}
                          </>
                        ) : emp.calendarUrl ? (
                          'なし'
                        ) : (
                          '未設定'
                        )}
                      </span>
                    </div>
                    <button onClick={() => handleClockOut(emp.id)} disabled={att.status === 'done' || att.status === 'not-clocked'} style={{ fontSize: '24px' }}>
                      退勤
                    </button>
                    <button onClick={() => handleBreakToggle(emp.id)} disabled={att.status === 'not-clocked' || att.status === 'done'} style={{ fontSize: '24px' }}>
                      {att.status === 'break' ? '休憩終了' : '休憩開始'}
                    </button>
                    <button onClick={() => handleOutToggle(emp.id)} disabled={att.status === 'not-clocked' || att.status === 'done'} style={{ fontSize: '24px' }}>
                      {att.status === 'out' ? '外出戻り' : '外出開始'}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="footer">
            <p>本日合計: {minutesToLabel(totalMinutes)}</p>
            <p className="muted">月次CSVはfreeeのサンプル（集計形式）に合わせて出力します。</p>
          </footer>
        </>
      )}

      {view === 'settings' && (
        <section className="settings">
          <section className="holiday-panel">
            <div>
              <p className="panel-title">休日カレンダー (Google 公開 ICS)</p>
              <p className="panel-desc">祝日(全国)と、会社の所定休日(任意)の公開ICSを設定できます。</p>
            </div>
            <div className="holiday-inputs-column">
              <div className="holiday-inputs">
                <input
                  className="text-input"
                  value={state.holidayUrl}
                  onChange={(e) => setState((prev) => ({ ...prev, holidayUrl: e.target.value }))}
                  placeholder="祝日ICS: https://...ics"
                />
                <span className="pill small">{holidayState.status === 'loading' ? '同期中' : '更新済'}</span>
                <span className="pill small subtle">個人カレンダー: {calendarStatus === 'loading' ? '同期中' : '更新済'}</span>
              </div>
              <div className="holiday-inputs">
                <input
                  className="text-input"
                  value={state.companyHolidayUrl}
                  onChange={(e) => setState((prev) => ({ ...prev, companyHolidayUrl: e.target.value }))}
                  placeholder="所定休日ICS(任意): https://...ics"
                />
                <span className="pill small">{companyHolidayState.status === 'loading' ? '同期中' : '更新済'}</span>
                <span className="pill small subtle">所定休日</span>
              </div>
            </div>
          </section>

          <div className="settings-header">
            <div>
              <p className="panel-title">従業員情報・個人カレンダー</p>
              <p className="panel-desc">freee取込用に「従業員番号」を管理します。所定は 9:00-18:00 / 休憩1h30m 固定です。</p>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button 
                className="ghost-button" 
                onClick={saveEmployeeSettings}
                disabled={!pendingEmployeeChanges}
                style={{ 
                  backgroundColor: pendingEmployeeChanges ? '#4CAF50' : undefined,
                  color: pendingEmployeeChanges ? 'white' : undefined,
                  fontWeight: pendingEmployeeChanges ? 'bold' : undefined
                }}
              >
                {pendingEmployeeChanges ? '変更を保存' : '保存済み'}
              </button>
              <button className="ghost-button" onClick={addEmployee}>メンバーを追加</button>
            </div>
          </div>
          <div className="settings-list">
            {state.employees.map((emp) => (
              <div key={emp.id} className="settings-row">
                <div className="input-group">
                  <label>従業員番号</label>
                  <input
                    className="text-input"
                    value={emp.employeeNumber ?? ''}
                    onChange={(e) => updateEmployeeNumber(emp.id, e.target.value)}
                    placeholder="例: 42"
                  />
                </div>
                <div className="input-group">
                  <label>氏名</label>
                  <input
                    className="text-input"
                    value={emp.name}
                    onChange={(e) => updateEmployeeField(emp.id, 'name', e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label>役割</label>
                  <input
                    className="text-input"
                    value={emp.role}
                    onChange={(e) => updateEmployeeField(emp.id, 'role', e.target.value)}
                  />
                </div>
                <div className="input-group">
                  <label>個人ICS (任意)</label>
                  <input
                    className="text-input"
                    value={emp.calendarUrl ?? ''}
                    onChange={(e) => updateEmployeeField(emp.id, 'calendarUrl', e.target.value)}
                    placeholder="https://...ics"
                  />
                </div>
                {emp.calendarUrl && (
                  <a className="pill link" href={emp.calendarUrl} target="_blank" rel="noreferrer">
                    カレンダーを開く
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {view === 'monthly' && (
        <section className="settings">
          <div className="settings-header">
            <div>
              <p className="panel-title">月次CSV / 閲覧</p>
              <p className="panel-desc">月を選択して、一覧表示と freee 取込（集計形式）のCSV出力ができます。</p>
            </div>
            <div className="report-controls">
              <input
                className="text-input"
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
              <button className="ghost-button" onClick={exportMonthlyCsv}>
                freee形式CSVをダウンロード
              </button>
            </div>
          </div>

          <div className="report-list">
            {state.employees.map((emp) => {
              const items = monthAttendanceByEmployee[emp.id] ?? [];
              const total = items.reduce((sum, att) => sum + computeWorkedMinutes(att), 0);
              return (
                <div key={emp.id} className="report-employee">
                  <div className="report-employee-header">
                    <div>
                      <p className="card-name">{emp.name}</p>
                      <p className="card-role">{emp.role}</p>
                    </div>
                    <span className="pill small">月合計: {minutesToLabel(total)}</span>
                  </div>

                  {items.length === 0 ? (
                    <p className="muted">この月のデータはありません。</p>
                  ) : (
                    <div className="report-table">
                      <div className="report-row report-head">
                        <div>日付</div>
                        <div>状態</div>
                        <div>出勤</div>
                        <div>退勤</div>
                        <div>休憩</div>
                        <div>場所</div>
                        <div>勤務</div>
                      </div>
                      {items.map((att) => {
                        const breakStart = att.breaks[0]?.start ? formatTime(att.breaks[0].start) : '';
                        const breakEnd = att.breaks[0]?.end ? formatTime(att.breaks[0].end) : '';
                        const breakLabel = breakStart || breakEnd ? `${breakStart}${breakEnd ? `-${breakEnd}` : ''}` : '--';
                        return (
                          <div key={attendanceKey(att.date, att.employeeId)} className="report-row">
                            <div>{att.date}</div>
                            <div>{statusLabelMap[att.status]}</div>
                            <div>{att.clockIn ? formatTime(att.clockIn) : '--:--'}</div>
                            <div>{att.clockOut ? formatTime(att.clockOut) : '--:--'}</div>
                            <div>{breakLabel}</div>
                            <div>{locationLabel[att.location]}</div>
                            <div>{minutesToLabel(computeWorkedMinutes(att))}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

type SummaryCardProps = { label: string; value: number; tone: 'green' | 'yellow' | 'red' | 'gray' };

function SummaryCard({ label, value, tone }: SummaryCardProps) {
  return (
    <div className={`summary-card ${tone}`}>
      <p className="summary-label">{label}</p>
      <p className="summary-value">{value}人</p>
    </div>
  );
}

export default App;
