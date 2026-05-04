import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import type { RequireAuthProp, StrictAuthProp } from '@clerk/clerk-sdk-node';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Extend express Request interface to include Clerk auth
declare global {
  namespace Express {
    interface Request extends StrictAuthProp {}
  }
}

// Basic health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Middleware to require authentication for all /api routes
app.use('/api', ClerkExpressRequireAuth() as any);

// Sync Endpoint - PULL
app.get('/api/sync/pull', async (req, res) => {
  try {
    const userId = req.auth.userId;
    // const lastSync = req.query.lastSync;

    // Fetch user's data from NeonDB
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // Create user if they don't exist yet
      await prisma.user.create({ data: { id: userId, email: '' } });
    }

    const plans = await prisma.workoutPlan.findMany({ 
      where: { userId },
      include: { days: { include: { exercises: true } } }
    });

    const sessions = await prisma.workoutSession.findMany({
      where: { userId },
      include: { sets: true }
    });

    res.json({
      success: true,
      data: {
        plans,
        sessions
      }
    });
  } catch (error) {
    console.error('Pull Error:', error);
    res.status(500).json({ error: 'Failed to pull sync data' });
  }
});

// Sync Endpoint - PUSH (Handle Offline Queue)
app.post('/api/sync/push', async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { queue } = req.body; // Array of operations from SQLite sync_queue

    // In a production app, we would process the queue sequentially:
    for (const op of queue) {
      const payload = JSON.parse(op.payload);
      
      if (op.entity_type === 'session' && op.operation === 'CREATE') {
        // Handle Session creation
        await prisma.workoutSession.upsert({
          where: { id: op.entity_id },
          create: {
            id: op.entity_id,
            userId,
            planId: payload.planId,
            planDayId: payload.planDayId,
            date: payload.date,
            startTime: payload.startTime ? new Date(payload.startTime) : null,
            endTime: payload.endTime ? new Date(payload.endTime) : null,
            status: payload.status,
            notes: payload.notes
          },
          update: {
            endTime: payload.endTime ? new Date(payload.endTime) : null,
            status: payload.status,
            notes: payload.notes
          }
        });
      }
      
      if (op.entity_type === 'set' && op.operation === 'CREATE') {
        // Handle Set creation
        await prisma.workoutSet.upsert({
          where: { id: op.entity_id },
          create: {
            id: op.entity_id,
            sessionId: payload.sessionId,
            exerciseId: payload.exerciseId,
            orderIndex: payload.orderIndex,
            weight: payload.weight,
            reps: payload.reps,
            isCompleted: payload.isCompleted,
            isWarmup: payload.isWarmup
          },
          update: {
            weight: payload.weight,
            reps: payload.reps,
            isCompleted: payload.isCompleted
          }
        });
      }
    }

    res.json({ success: true, processed: queue.length });
  } catch (error) {
    console.error('Push Error:', error);
    res.status(500).json({ error: 'Failed to process sync queue' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MuscleMemory Backend running on http://localhost:${PORT}`);
});
