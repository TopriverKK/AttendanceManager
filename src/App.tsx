import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type WorkStatus = 'not-clocked' | 'working' | 'break' | 'out' | 'done';
type WorkLocation = 'office' | 'remote' | 'out';

type Employee = {
  id: string;
  name: string;
  role: string;
  avatarHue: number;
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
};

type CalendarEvent = {
  start: string;
  end?: string;
  summary?: string;
  location?: string;
};

const initialEmployees: Employee[] = [
  { id: 'emp-1', name: '山田 太郎', role: 'エンジニア', avatarHue: 160 },
  { id: 'emp-2', name: '沢田 綾菜', role: 'デザイナー', avatarHue: 38 },
  { id: 'emp-3', name: '藤小 岬里', role: 'エンジニア', avatarHue: 32 },
  { id: 'emp-4', name: '渥田 郁奏', role: 'エンジニア', avatarHue: 200 },
  { id: 'emp-5', name: '佐田 旦介', role: 'エンジニア', avatarHue: 0 },
];

const defaultHolidayIcs =
  'https://www.google.com/calendar/ical/ja.japanese%23holiday%40group.v.calendar.google.com/public/basic.ics';

const storageKey = 'attendance-dashboard-state';
const remoteStateEndpoint = '/api/state';

const attendanceKey = (date: string, employeeId: string) => `${date}:${employeeId}`;

const nowIso = () => new Date().toISOString();
const todayKey = () => new Date().toISOString().slice(0, 10);

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

  const normalizePersisted = useCallback((parsed: PersistedState) => {
    const migrated = migrateAttendanceToDatedKeys(parsed.attendance);
    const today = todayKey();
    return {
      employees: parsed.employees,
      attendance: ensureAttendanceForEmployeesForDate(parsed.employees, migrated, today),
      holidayUrl: parsed.holidayUrl,
    } satisfies PersistedState;
  }, []);

  const loadRemote = useCallback(async () => {
    try {
      const res = await fetch(remoteStateEndpoint, { method: 'GET' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`Remote state GET failed: ${res.status} ${res.statusText}`, body);
        return;
      }
      const data = (await res.json()) as { state: PersistedState | null; updatedAt?: string };
      if (!data?.state) return;

      const normalized = normalizePersisted(data.state);
      const serialized = JSON.stringify(normalized);

      setState((prev) => {
        const prevSerialized = JSON.stringify(prev);
        if (prevSerialized === serialized) return prev;
        
        // If we just saved this exact state to remote, don't reload it
        if (serialized === lastAppliedRemoteRef.current) return prev;
        
        // If user is actively editing (within 2 seconds), defer the update
        if (Date.now() - lastLocalChangeAtRef.current < 2000) {
          console.info('Deferring remote update while user is editing');
          return prev;
        }

        // Apply remote state - prioritize server data for cross-device sync
        lastAppliedRemoteRef.current = serialized;
        lastSavedRef.current = serialized;
        localStorage.setItem(storageKey, serialized);
        return normalized;
      });
    } catch (err) {
      // Network error or CORS - fall back to localStorage silently
      console.info('Remote state unavailable (using localStorage only)');
    }
  }, [normalizePersisted]);

  const scheduleRemoteSave = useCallback(
    (next: PersistedState) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      pendingSaveRef.current = true;
      saveTimerRef.current = window.setTimeout(async () => {
        try {
          const res = await fetch(remoteStateEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: next }),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.warn(`Remote state POST failed: ${res.status} ${res.statusText}`, body);
          } else {
            // Treat this state as the current remote snapshot to avoid echo loops.
            lastAppliedRemoteRef.current = JSON.stringify(next);
            console.info('State saved to remote storage');
          }
        } catch (err) {
          // Network error - fall back to localStorage silently
          console.info('Remote state unavailable (using localStorage only)');
        } finally {
          pendingSaveRef.current = false;
        }
      }, 500);
    },
    [],
  );

  const [state, setState] = useState<PersistedState>(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as PersistedState;
        if (parsed.attendance && parsed.holidayUrl && parsed.employees) {
          const normalized = normalizePersisted(parsed);
          lastSavedRef.current = JSON.stringify(normalized);
          return normalized;
        }
      } catch (err) {
        console.warn('state parse error', err);
      }
    }
    const today = todayKey();
    const fallback: PersistedState = {
      employees: initialEmployees,
      attendance: buildInitialAttendanceForDate(initialEmployees, today),
      holidayUrl: defaultHolidayIcs,
    };
    lastSavedRef.current = JSON.stringify(fallback);
    return fallback;
  });

  useEffect(() => {
    const serialized = JSON.stringify(state);
    lastSavedRef.current = serialized;
    lastLocalChangeAtRef.current = Date.now();
    localStorage.setItem(storageKey, serialized);
    // If this state came from the server, don't POST it back immediately.
    if (serialized !== lastAppliedRemoteRef.current) {
      scheduleRemoteSave(state);
    }
  }, [scheduleRemoteSave, state]);

  // Note: keep history. We only ensure today's records exist when needed.

  const refreshFromStorage = useCallback(() => {
    const stored = localStorage.getItem(storageKey);
    if (!stored || stored === lastSavedRef.current) return;
    try {
      const parsed = JSON.parse(stored) as PersistedState;
      if (parsed.attendance && parsed.holidayUrl && parsed.employees) {
        setState((prev) => {
          const next = normalizePersisted(parsed);
          const currentString = JSON.stringify(prev);
          const nextString = JSON.stringify(next);
          if (currentString === nextString) return prev;
          lastSavedRef.current = nextString;
          return next;
        });
      }
    } catch (err) {
      console.warn('refresh parse error', err);
    }
  }, [normalizePersisted]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) refreshFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [refreshFromStorage]);

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

    // Poll every 5 seconds for cross-device sync
    const id = window.setInterval(() => {
      if (pendingSaveRef.current) return;
      void loadRemote();
    }, 5_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(id);
    };
  }, [loadRemote]);

  return [state, setState, refreshFromStorage] as const;
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

  const fetchIcsText = useCallback(async (url: string) => {
    const target = canonicalizeIcsUrl(url);
    const candidates = [
      // allorigins returns raw content for ICS
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      // thingproxy as alternative
      `https://thingproxy.freeboard.io/fetch/${target}`,
      `https://corsproxy.io/?${encodeURIComponent(target)}`,
      // Fallback to direct (will often fail on CORS but kept as last resort)
      target,
    ];

    let lastErr: unknown = null;
    for (const endpoint of candidates) {
      try {
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
        const text = await res.text();
        if (!text.trim()) throw new Error('ICS empty response');
        return text;
      } catch (err) {
        lastErr = err;
        console.warn('ICS fetch failed candidate', endpoint, err);
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
      for (const emp of employees) {
        if (!emp.calendarUrl) {
          nextMap[emp.id] = null;
          currentMap[emp.id] = null;
          continue;
        }
        try {
          const text = await fetchIcsText(emp.calendarUrl);
          const { next, current } = pickNextAndCurrentEventFromIcs(text);
          nextMap[emp.id] = next;
          currentMap[emp.id] = current;
        } catch (err) {
          console.warn('calendar fetch error', err);
          nextMap[emp.id] = null;
          currentMap[emp.id] = null;
        }
      }
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
  }, [employees, refreshKey]);

  return { nextEvents, currentEvents, status };
}

type HolidayState = { dates: Set<string>; status: 'idle' | 'loading' | 'error' };

function useHolidayFeed(url: string) {
  const [holidayState, setHolidayState] = useState<HolidayState>({ dates: new Set(), status: 'idle' });

  useEffect(() => {
    const fetchHolidays = async () => {
      setHolidayState({ dates: new Set(), status: 'loading' });
      try {
        const target = canonicalizeIcsUrl(url);
        const candidates = [
          // allorigins returns raw content for ICS
          `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
          // thingproxy as alternative
          `https://thingproxy.freeboard.io/fetch/${target}`,
          `https://corsproxy.io/?${encodeURIComponent(target)}`,
          target,
        ];
        let lastErr: unknown = null;
        let text = '';
        for (const endpoint of candidates) {
          try {
            const res = await fetch(endpoint);
            if (!res.ok) throw new Error(`ICS fetch failed: ${res.status}`);
            text = await res.text();
            if (!text.trim()) throw new Error('ICS empty response');
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            console.warn('holiday ICS fetch failed candidate', endpoint, err);
          }
        }
        if (lastErr) throw lastErr;
        const matches = [...text.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
        const dates = new Set(matches.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`));
        setHolidayState({ dates, status: 'idle' });
      } catch (err) {
        console.error(err);
        setHolidayState({ dates: new Set(), status: 'error' });
      }
    };
    fetchHolidays();
  }, [url]);

  return holidayState;
}

function App() {
  const [state, setState, refreshFromStorage] = usePersistentState();
  const [view, setView] = useState<'dashboard' | 'monthly' | 'settings'>('dashboard');
  const [calendarTick, setCalendarTick] = useState(0);
  const holidayState = useHolidayFeed(state.holidayUrl);
  const { nextEvents, currentEvents, status: calendarStatus } = useEmployeeCalendars(state.employees, calendarTick);

  useEffect(() => {
    refreshFromStorage();
    const id = setInterval(() => {
      refreshFromStorage();
      setCalendarTick((tick) => tick + 1);
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshFromStorage]);

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
      return {
        ...prev,
        attendance: {
          ...nextAttendance,
          [key]: updater(nextAttendance[key]),
        },
      };
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
    const headers = ['社員番号', '日付', '出勤時刻', '退勤時刻', '休憩開始', '休憩終了', '勤務場所', 'メモ'];
    const employeeCodeMap = new Map(state.employees.map((emp, idx) => [emp.id, String(idx + 1).padStart(4, '0')] as const));
    const prefix = `${selectedMonth}-`;
    const records = Object.values(state.attendance)
      .filter((att) => att.date.startsWith(prefix))
      .sort((a, b) => {
        const dateCmp = a.date.localeCompare(b.date);
        if (dateCmp !== 0) return dateCmp;
        const aIdx = state.employees.findIndex((e) => e.id === a.employeeId);
        const bIdx = state.employees.findIndex((e) => e.id === b.employeeId);
        return aIdx - bIdx;
      });

    const lines = records.map((att) => {
      const employeeCode = employeeCodeMap.get(att.employeeId) ?? '0000';
      const breakStart = att.breaks[0]?.start ? formatTime(att.breaks[0].start) : '';
      const breakEnd = att.breaks[0]?.end ? formatTime(att.breaks[0].end) : '';
      return [
        employeeCode,
        att.date,
        att.clockIn ? formatTime(att.clockIn) : '',
        att.clockOut ? formatTime(att.clockOut) : '',
        breakStart,
        breakEnd,
        locationLabel[att.location],
        att.notes ?? '',
      ].join(',');
    });

    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-${selectedMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isHoliday = holidayState.dates.has(today);

  const updateEmployeeField = (id: string, field: keyof Employee, value: string) => {
    setState((prev) => {
      const employees = prev.employees.map((emp) => (emp.id === id ? { ...emp, [field]: value } : emp));
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      return { ...prev, employees, attendance: ensureAttendanceForEmployeesForDate(employees, migrated, todayKey()) };
    });
  };

  const addEmployee = () => {
    const newId = `emp-${Date.now()}`;
    const newEmployee: Employee = {
      id: newId,
      name: '新規メンバー',
      role: '役割',
      avatarHue: Math.floor(Math.random() * 360),
      calendarUrl: '',
    };
    setState((prev) => {
      const employees = [...prev.employees, newEmployee];
      const migrated = migrateAttendanceToDatedKeys(prev.attendance);
      const attendance = ensureAttendanceForEmployeesForDate(employees, migrated, todayKey());
      return { ...prev, employees, attendance };
    });
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

          <section className="holiday-panel">
            <div>
              <p className="panel-title">休日カレンダー (Google 公開 ICS)</p>
              <p className="panel-desc">日本の祝日ICSをデフォルト設定。公開ICSのURLを上書きできます。</p>
            </div>
            <div className="holiday-inputs">
              <input
                className="text-input"
                value={state.holidayUrl}
                onChange={(e) => setState((prev) => ({ ...prev, holidayUrl: e.target.value }))}
                placeholder="https://...ics"
              />
              <span className="pill small">{holidayState.status === 'loading' ? '同期中' : '更新済'}</span>
              <span className="pill small subtle">個人カレンダー: {calendarStatus === 'loading' ? '同期中' : '更新済'}</span>
            </div>
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
                <article key={emp.id} className="card">
                  <div className="card-top">
                    <div className="avatar" style={{ background: `hsl(${emp.avatarHue} 55% 75%)` }} />
                    <div>
                      <p className="card-name">{emp.name}</p>
                      <p className="card-role">{emp.role}</p>
                    </div>
                    <span className={`status-pill ${statusToneMap[att.status]}`}>{statusLabelMap[att.status]}</span>
                  </div>

                  <div className="card-row">
                    <div>
                      <p className="label">出勤</p>
                      <p className="value">{formatTime(att.clockIn)}</p>
                    </div>
                    <div>
                      <p className="label">本日勤務</p>
                      <p className="value">{minutesToLabel(workedMinutes)}</p>
                    </div>
                    <div>
                      <p className="label">勤務場所</p>
                      <p className="value subtle">{locationLabel[att.location]}</p>
                    </div>
                  </div>

                  <div className="next-event">
                    <p className="label">現在の予定</p>
                    <p className="value">
                      {emp.calendarUrl
                        ? currentEvent
                          ? `${formatDateTime(currentEvent.start)}${currentEvent.end ? ` - ${formatDateTime(currentEvent.end)}` : ''} ${
                              currentEvent.summary ?? ''
                            }`.trim()
                          : 'なし / 取得中'
                        : '未設定'}
                    </p>
                    {currentEvent?.location && <p className="muted">{currentEvent.location}</p>}
                  </div>

                  <div className="next-event">
                    <p className="label">次の予定</p>
                    <p className="value">
                      {emp.calendarUrl
                        ? nextEvent
                          ? `${formatDateTime(nextEvent.start)} ${nextEvent.summary ?? ''}`.trim()
                          : '予定なし / 取得中'
                        : '未設定'}
                    </p>
                    {nextEvent?.location && <p className="muted">{nextEvent.location}</p>}
                  </div>

                  <div className="actions">
                    <button onClick={() => handleClockIn(emp.id, 'office')} disabled={att.status === 'working'}>
                      出勤(オフィス)
                    </button>
                    <button onClick={() => handleClockIn(emp.id, 'remote')} disabled={att.status === 'working'}>
                      出勤(テレワーク)
                    </button>
                    <button onClick={() => handleClockOut(emp.id)} disabled={att.status === 'done' || att.status === 'not-clocked'}>
                      退勤
                    </button>
                  </div>

                  <div className="actions secondary">
                    <button onClick={() => handleBreakToggle(emp.id)} disabled={att.status === 'not-clocked' || att.status === 'done'}>
                      {att.status === 'break' ? '休憩終了' : '休憩開始'}
                    </button>
                    <button onClick={() => handleOutToggle(emp.id)} disabled={att.status === 'not-clocked' || att.status === 'done'}>
                      {att.status === 'out' ? '外出戻り' : '外出開始'}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>

          <footer className="footer">
            <p>本日合計: {minutesToLabel(totalMinutes)}</p>
            <p className="muted">CSVはFreee勤怠インポート用の暫定列です。公式仕様に合わせて後調整してください。</p>
          </footer>
        </>
      )}

      {view === 'settings' && (
        <section className="settings">
          <div className="settings-header">
            <div>
              <p className="panel-title">従業員情報・個人カレンダー</p>
              <p className="panel-desc">名前・役割・個人ICSリンクを管理します。保存は自動です。</p>
            </div>
            <button className="ghost-button" onClick={addEmployee}>メンバーを追加</button>
          </div>
          <div className="settings-list">
            {state.employees.map((emp) => (
              <div key={emp.id} className="settings-row">
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
              <p className="panel-desc">月を選択して、勤怠の一覧表示とCSV出力ができます。</p>
            </div>
            <div className="report-controls">
              <input
                className="text-input"
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
              <button className="ghost-button" onClick={exportMonthlyCsv}>
                CSVをダウンロード
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
