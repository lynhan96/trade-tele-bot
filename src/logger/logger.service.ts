import { Injectable, LoggerService as NestLoggerService } from "@nestjs/common";
import * as winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import * as path from "path";

@Injectable()
export class FileLoggerService implements NestLoggerService {
  private logger: winston.Logger;
  private context?: string;

  constructor() {
    const logDir = path.join(process.cwd(), "logs");

    // Error logs - keep for 30 days
    const errorFileTransport = new DailyRotateFile({
      filename: path.join(logDir, "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      level: "error",
      maxFiles: "30d",
      maxSize: "20m",
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
    });

    // Combined logs - keep for 14 days
    const combinedFileTransport = new DailyRotateFile({
      filename: path.join(logDir, "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
      maxSize: "20m",
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
    });

    // Console transport with colors
    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(
          ({ timestamp, level, message, context, stack }) => {
            const ctx = context ? `[${context}]` : "";
            const stackTrace = stack ? `\n${stack}` : "";
            return `${timestamp} ${level} ${ctx} ${message}${stackTrace}`;
          },
        ),
      ),
    });

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      transports: [errorFileTransport, combinedFileTransport, consoleTransport],
    });
  }

  setContext(context: string) {
    this.context = context;
  }

  log(message: any, context?: string) {
    this.logger.info(message, { context: context || this.context });
  }

  error(message: any, trace?: string, context?: string) {
    this.logger.error(message, {
      context: context || this.context,
      stack: trace,
    });
  }

  warn(message: any, context?: string) {
    this.logger.warn(message, { context: context || this.context });
  }

  debug(message: any, context?: string) {
    this.logger.debug(message, { context: context || this.context });
  }

  verbose(message: any, context?: string) {
    this.logger.verbose(message, { context: context || this.context });
  }

  // Additional method for structured error logging
  logError(error: Error, additionalInfo?: Record<string, any>) {
    this.logger.error({
      message: error.message,
      stack: error.stack,
      name: error.name,
      timestamp: new Date().toISOString(),
      ...additionalInfo,
    });
  }

  // Log API errors with details
  logApiError(
    exchange: string,
    operation: string,
    error: any,
    userId?: number,
    symbol?: string,
  ) {
    this.logger.error({
      type: "API_ERROR",
      exchange,
      operation,
      userId,
      symbol,
      errorMessage: error.message,
      errorCode: error.code,
      errorResponse: error.response?.data,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    });
  }

  // Log business logic errors
  logBusinessError(
    operation: string,
    error: any,
    userId?: number,
    additionalData?: Record<string, any>,
  ) {
    this.logger.error({
      type: "BUSINESS_ERROR",
      operation,
      userId,
      errorMessage: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      ...additionalData,
    });
  }
}
