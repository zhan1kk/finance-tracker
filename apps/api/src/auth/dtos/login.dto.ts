import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class LoginDTO {
  @IsEmail()
  public readonly email!: string;

  @IsString()
  @IsNotEmpty()
  public readonly password!: string;
}
