# Abhishek Singha Online Test

A self-hosted MCQ examination platform with an administrator dashboard, student accounts (capacity enforced at 100), timed exams, CSV question/student imports, automatic marking (+4 correct, -1 incorrect, 0 skipped), and per-exam leaderboard.

## Important deployment note

This is a deployable application source package, not a website already published to the public internet. To make it live, deploy it to a Node.js host and configure a persistent disk. No hosting account or domain was connected when this package was created.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
cp .env.example .env
# Edit .env and set strong SESSION_SECRET and ADMIN_PASSWORD
npm start
```

Open `http://localhost:3000`. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`.

## Deploy to Render (recommended setup)

This project includes `render.yaml` for a Render Blueprint deployment. It configures a paid Starter web service and a 1 GB persistent disk mounted at `/var/data`, because this application stores its SQLite database and login sessions on disk. The Blueprint generates `SESSION_SECRET` automatically and asks you to enter `ADMIN_PASSWORD` privately during setup. Do not put passwords in the source code or Git repository.

1. Create a private GitHub repository and upload the contents of this project.
2. Create a Render account and connect GitHub.
3. In Render, choose **New + → Blueprint**, then select the private repository.
4. When prompted, enter a strong unique value for `ADMIN_PASSWORD`. Keep it private.
5. Review the paid Starter service and persistent disk charges, then apply the Blueprint.
6. Wait for the deploy to finish and open the generated `onrender.com` HTTPS URL.
7. Sign in with username `admin` and the admin password you supplied. Immediately create student accounts and run a full test exam before inviting students.

Do not use a Free Render web service for a real exam with this SQLite setup: Free web services do not support persistent disks. Free Render Postgres databases expire after 30 days. For an exam platform that must retain accounts, questions and results, use persistent storage and backups.

For a production exam day, use a paid instance with persistent storage, enable backups, test load with 100 concurrent students, and arrange a support contact. SQLite is suitable for a modest single-instance deployment; for larger growth or multiple app instances, migrate to PostgreSQL and a shared session store.

## Admin workflow

1. Log in using the admin account.
2. Create an examination and set its duration.
3. Add MCQs manually or import CSV.
4. Publish the exam. Only published exams appear to students.
5. Register up to 100 students through CSV.
6. Share the website URL and each student's username/password privately.
7. View results and ranks from **Results & ranks**.

### Question CSV format

UTF-8 CSV with these exact headers:

```csv
question,A,B,C,D,correct,explanation
Which organelle is called the powerhouse of the cell?,Nucleus,Mitochondrion,Ribosome,Golgi body,B,It is the major site of ATP production.
```

The `correct` field must be A, B, C or D. Avoid commas inside unquoted CSV cells; quote fields that contain commas or line breaks.

### Student CSV format

```csv
username,name,password
NEET001,Student One,TempPass123
NEET002,Student Two,TempPass456
```

Passwords must be at least 8 characters. Usernames must be unique. The application refuses imports that would exceed 100 registered student accounts.

## Marking and ranking

- Correct: +4
- Incorrect: -1
- Unanswered: 0
- Rank: score descending; earlier submission breaks ties.

## Security / operational checklist before a real exam

- Change all example credentials and use a unique strong `SESSION_SECRET`.
- Keep the admin password private and rotate it if exposed.
- Do not share the CSV answer key with students.
- Use HTTPS (Render provides this on its public service URL).
- Configure persistent storage and backups.
- Run a rehearsal with test student accounts, including expiry, submit, and leaderboard checks.
- Load-test the actual hosting plan with 100 simultaneous sessions before a high-stakes exam.

## Current limitations

This starter release uses SQLite on one application instance. It does not yet include student self-service password reset, email/SMS delivery, question randomization, proctoring, detailed answer explanations/review after submission, or PostgreSQL multi-instance scaling. Add these before using it for high-stakes examinations.
