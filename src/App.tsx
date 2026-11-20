import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { AdminDashboard } from './components/AdminDashboard';
import { AuthGate } from './components/AuthGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator } from './components/OfflineIndicator';
import { StudentWorkspace } from './components/StudentWorkspace';
import { TeacherWorkspace } from './components/TeacherWorkspace';
import { auth } from './lib/firebase';
import {
  attemptAutoClaimRole,
  fetchPublicProfilesByIds,
  fetchStudentRecord,
  fetchSubjectsByIds,
  fetchTopicsByIds,
  subscribeAdminSubjects,
  subscribeAdminTeachers,
  subscribeAdminTopics,
  subscribeGrowthRecordsByRole,
  subscribeInstitution,
  subscribeStudentsForAdmin,
  subscribeStudentsForTeacher,
  subscribeTeacherSubjects,
  subscribeTeacherTopics,
} from './lib/sikshaliteService';
import type {
  GrowthRecord,
  Institution,
  PublicProfile,
  StudentRecord,
  Subject,
  TeacherRecord,
  Topic,
  UserProfile,
} from './types/sikshalite';

function SikshaliteApp() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const [institution, setInstitution] = useState<Institution | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [teachers, setTeachers] = useState<TeacherRecord[]>([]);
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [growthRecords, setGrowthRecords] = useState<GrowthRecord[]>([]);
  const [studentRecord, setStudentRecord] = useState<StudentRecord | null>(null);
  const [teacherProfiles, setTeacherProfiles] = useState<PublicProfile[]>([]);

  const resolveProfile = useCallback(async (user: User | null) => {
    if (!user) {
      setProfile(null);
      setInstitution(null);
      setSubjects([]);
      setTeachers([]);
      setStudents([]);
      setTopics([]);
      setGrowthRecords([]);
      setStudentRecord(null);
      setTeacherProfiles([]);
      return;
    }
    const pendingVerifiedPhone =
      typeof window !== 'undefined'
        ? window.sessionStorage.getItem('sikshalite_verified_phone') || undefined
        : undefined;
    const resolved = await attemptAutoClaimRole(user, pendingVerifiedPhone);
    if (resolved && typeof window !== 'undefined') {
      window.sessionStorage.removeItem('sikshalite_verified_phone');
    }
    setProfile(resolved);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      setAuthLoading(true);
      try {
        await resolveProfile(user);
      } finally {
        setAuthLoading(false);
      }
    });
    return () => unsub();
  }, [resolveProfile]);

  useEffect(() => {
    if (!profile) return;

    let cancelled = false;
    const unsubs: (() => void)[] = [];
    unsubs.push(subscribeInstitution(profile.institutionId, setInstitution));

    if (profile.role === 'admin') {
      unsubs.push(subscribeAdminSubjects(profile.uid, setSubjects));
      unsubs.push(subscribeAdminTeachers(profile.uid, setTeachers));
      unsubs.push(subscribeStudentsForAdmin(profile.uid, setStudents));
      unsubs.push(subscribeAdminTopics(profile.uid, setTopics));
      unsubs.push(subscribeGrowthRecordsByRole('admin', profile.uid, setGrowthRecords));
    } else if (profile.role === 'teacher') {
      unsubs.push(subscribeTeacherSubjects(profile.uid, setSubjects));
      unsubs.push(subscribeTeacherTopics(profile.uid, setTopics));
      unsubs.push(subscribeStudentsForTeacher(profile.uid, setStudents));
      unsubs.push(subscribeGrowthRecordsByRole('teacher', profile.uid, setGrowthRecords));
    } else if (profile.role === 'student') {
      unsubs.push(subscribeGrowthRecordsByRole('student', profile.uid, setGrowthRecords));

      (async () => {
        try {
          const stu = await fetchStudentRecord(profile.memberId);
          if (cancelled) return;
          setStudentRecord(stu);
          if (stu) {
            const enrolled = await fetchSubjectsByIds(stu.enrolledSubjectIds);
            if (cancelled) return;
            setSubjects(enrolled);
            const allTopicIds = enrolled.flatMap((s) => s.topicIds);
            const loadedTopics = await fetchTopicsByIds(allTopicIds);
            if (cancelled) return;
            setTopics(loadedTopics);
            const allTeacherIds = enrolled.flatMap((s) => s.teacherIds);
            const tProfiles = await fetchPublicProfilesByIds(allTeacherIds);
            if (cancelled) return;
            setTeacherProfiles(tProfiles);
          }
        } catch (err) {
          console.error('Failed to load student workspace data:', err);
        }
      })();
    }

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [profile]);

  const handleInstitutionReset = useCallback(() => {
    setProfile(null);
    setInstitution(null);
    setSubjects([]);
    setTeachers([]);
    setStudents([]);
    setTopics([]);
    setGrowthRecords([]);
  }, []);

  if (authLoading || !firebaseUser || !profile) {
    return (
      <>
        <AuthGate
          firebaseUser={firebaseUser}
          authLoading={authLoading}
          onProfileResolved={(p) => {
            if (typeof window !== 'undefined') {
              window.sessionStorage.removeItem('sikshalite_verified_phone');
            }
            setProfile(p);
          }}
          onRecheckEnrollment={() => resolveProfile(firebaseUser)}
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <>
      {profile.role === 'admin' && (
        <AdminDashboard
          profile={profile}
          institution={institution}
          subjects={subjects}
          teachers={teachers}
          students={students}
          topics={topics}
          growthRecords={growthRecords}
          onInstitutionReset={handleInstitutionReset}
        />
      )}
      {profile.role === 'teacher' && (
        <TeacherWorkspace
          profile={profile}
          institution={institution}
          subjects={subjects}
          topics={topics}
          students={students}
          growthRecords={growthRecords}
        />
      )}
      {profile.role === 'student' && (
        <StudentWorkspace
          profile={profile}
          institution={institution}
          studentRecord={studentRecord}
          subjects={subjects}
          topics={topics}
          teacherProfiles={teacherProfiles}
          growthRecords={growthRecords}
        />
      )}
      <OfflineIndicator />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SikshaliteApp />
    </ErrorBoundary>
  );
}
