import { Injectable, Logger, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { Model } from "mongoose";
import * as bcrypt from "bcryptjs";
import * as jwt from "jsonwebtoken";
import { AdminAccount, AdminAccountDocument } from "../schemas/admin-account.schema";

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
}

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;

  constructor(
    @InjectModel(AdminAccount.name)
    private readonly adminAccountModel: Model<AdminAccountDocument>,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.get<string>("ADMIN_JWT_SECRET", "dts-admin-secret-change-me");
    this.jwtExpiresIn = this.configService.get<string>("ADMIN_JWT_EXPIRES_IN", "7d");
  }

  async onModuleInit() {
    await this.seedDefaultAdmin();
  }

  private async seedDefaultAdmin() {
    const count = await this.adminAccountModel.countDocuments();
    if (count > 0) return;

    const defaultUsername = this.configService.get<string>("ADMIN_DEFAULT_USERNAME", "admin");
    const defaultPassword = this.configService.get<string>("ADMIN_DEFAULT_PASSWORD", "admin123");
    const hash = await bcrypt.hash(defaultPassword, 10);

    await this.adminAccountModel.create({
      username: defaultUsername,
      passwordHash: hash,
      role: "admin",
      isActive: true,
    });
    this.logger.log(`Default admin account created (username: ${defaultUsername})`);
  }

  async login(username: string, password: string): Promise<{ token: string; user: { username: string; role: string } }> {
    const account = await this.adminAccountModel.findOne({ username, isActive: true });
    if (!account) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, account.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    await this.adminAccountModel.findByIdAndUpdate(account._id, { lastLoginAt: new Date() });

    const payload: JwtPayload = {
      sub: account._id.toString(),
      username: account.username,
      role: account.role,
    };
    const token = jwt.sign(payload, this.jwtSecret, { expiresIn: this.jwtExpiresIn as unknown as number });

    return {
      token,
      user: { username: account.username, role: account.role },
    };
  }

  async changePassword(username: string, oldPassword: string, newPassword: string): Promise<void> {
    const account = await this.adminAccountModel.findOne({ username });
    if (!account) throw new UnauthorizedException("Account not found");

    const valid = await bcrypt.compare(oldPassword, account.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid old password");

    account.passwordHash = await bcrypt.hash(newPassword, 10);
    await account.save();
  }

  verifyToken(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.jwtSecret) as JwtPayload;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
