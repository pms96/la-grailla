'use client'

import { motion, useReducedMotion } from 'framer-motion'

const viewportConfig = { once: true, margin: '-60px' as `${number}px` }

// Curva de ease-out reforzada (equivalente a --ease-out en globals.css) — más contundente que el 'easeOut' débil de Framer.
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]

export function FadeIn({
  children, delay = 0, duration = 0.4, className,
}: {
  children: React.ReactNode; delay?: number; duration?: number; className?: string
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewportConfig}
      transition={{ duration, delay, ease: EASE_OUT }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function ScaleIn({
  children, delay = 0, className,
}: {
  children: React.ReactNode; delay?: number; className?: string
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.95 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={viewportConfig}
      transition={{ duration: 0.3, delay, ease: EASE_OUT }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

const slideDirections = {
  bottom: { y: 20, x: 0 },
  top:    { y: -20, x: 0 },
  left:   { x: -20, y: 0 },
  right:  { x: 20, y: 0 },
}

export function SlideIn({
  children, from = 'bottom', delay = 0, className,
}: {
  children: React.ReactNode; from?: keyof typeof slideDirections; delay?: number; className?: string
}) {
  const reduceMotion = useReducedMotion()
  const offset = reduceMotion ? { x: 0, y: 0 } : slideDirections[from]
  return (
    <motion.div
      initial={{ opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={viewportConfig}
      transition={{ duration: 0.4, delay, ease: EASE_OUT }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function Stagger({
  children, staggerDelay = 0.08, className,
}: {
  children: React.ReactNode; staggerDelay?: number; className?: string
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      variants={{ show: { transition: { staggerChildren: reduceMotion ? 0 : staggerDelay } } }}
      initial="hidden"
      whileInView="show"
      viewport={viewportConfig}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: reduceMotion ? 0 : 16 },
        show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function HoverLift({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  return (
    <motion.div
      whileHover={{ y: -2, boxShadow: 'var(--shadow-lg)' }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function PressScale({
  children, className,
}: {
  children: React.ReactNode; className?: string
}) {
  return (
    <motion.div
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.1, ease: 'easeOut' }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

export function SkeletonPulse({ className }: { className?: string }) {
  return (
    <motion.div
      animate={{ opacity: [0.4, 1, 0.4] }}
      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
      className={`rounded-md bg-muted ${className ?? ''}`}
    />
  )
}
