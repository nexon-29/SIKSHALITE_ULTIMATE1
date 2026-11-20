# Sikshalite Security Specification (Phase 0 TDD)

## 1. Core Data Invariants
1. **Institution Ownership**: An Institution can only be modified by its verified `adminUid` (or bootstrapped system admin).
2. **Subject Isolation**: Teachers can ONLY create, edit, or delete Topics and grade GrowthRecords for `subjectId` values explicitly assigned to them in their `teachers/{teacherId}` record and mirrored in `subjects/{subjectId}`.
3. **Mobile-Linked Role Claiming**: Only a user whose verified phone number (`request.auth.token.phone_number`) or verified fallback email matches a `phoneLinks/{linkId}` entry may claim an unclaimed Teacher or Student account. Self-assigned admin escalation on someone else's institution is impossible.
4. **PII Isolation**: Phone numbers (`phoneE164`) and emails (`fallbackEmail`) reside in `users`, `teachers`, `students`, and `phoneLinks`—never exposed via blanket reads. Shared member views read only PII-free `publicProfiles` and `institutions`.
5. **Assessment & Grade Integrity**: Students cannot alter their `assignmentScore`, `assignmentFeedback`, or overwrite a completed `preTestCompleted` / `postTestCompleted` score once locked. Teachers cannot spoof student answers.
6. **Strict Server Timestamps & Bounded Payloads**: Every `create` validates `createdAt == request.time`, every `update` validates `updatedAt == request.time`, all IDs match `^[a-zA-Z0-9_\-]+$`, and all strings/arrays enforce strict upper bounds.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Shadow Role Escalation**: Student updates `/users/{uid}` adding `role: "admin"` or `isAdmin: true`.
2. **Cross-Subject Topic Injection**: Teacher assigned only to `subj_math` attempts to create `/topics/top_chem_1` with `subjectId: "subj_chem"`.
3. **Email Spoofing Admin Bypass**: Unverified token (`email_verified: false`) claims bootstrapped admin email `anitabiswas0986@gmail.com`.
4. **Ghost Field Injection**: Teacher creates a topic with extra shadow key `verifiedByMinistry: true`.
5. **ID Poisoning**: Attacker writes to `/subjects/` with a 1,500-character invalid document ID containing `/` or spaces.
6. **Student Self-Grading**: Student updates `/growthRecords/{recordId}` changing `assignmentScore: 100` or `assignmentStatus: "graded"`.
7. **Post-Completion Quiz Tampering**: Student updates `/growthRecords/{recordId}` after `preTestCompleted == true` to raise `preTestPercent`.
8. **Blanket Student List Scrape**: Unrelated signed-in user attempts `list` on `/students` or `/teachers` without matching `adminUid`, `claimedUid`, or `authorizedTeacherUids`.
9. **Client Timestamp Forgery**: User submits `createdAt: new Date("2020-01-01")` instead of `serverTimestamp()`.
10. **PII Theft via Get**: Student A attempts `getDoc` on Student B's `/students/{studentB}` document containing `phoneE164`.
11. **Orphaned GrowthRecord Creation**: Student creates `/growthRecords/fake_rec` pointing to a non-existent `topicId` or spoofed `adminUid`.
12. **Teacher Hijacking Unowned PhoneLink**: User with phone `+910000000000` tries to claim `/phoneLinks/phone_919999999999`.
